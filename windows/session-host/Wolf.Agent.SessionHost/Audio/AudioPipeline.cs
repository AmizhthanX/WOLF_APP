using System.Diagnostics;
using System.Runtime.Versioning;
using Concentus;
using Concentus.Enums;
using Microsoft.Extensions.Logging;

namespace Wolf.Agent.SessionHost.Audio;

/// <summary>One encoded Opus packet, ready for RTP.</summary>
public sealed record EncodedAudioFrame(byte[] Data, TimeSpan Duration, bool Silent);

/// <summary>Statistics for the audio half of a stream.</summary>
public sealed record AudioStats(
    long FramesEncoded,
    long FramesSilent,
    long BytesEncoded,
    long FramesDroppedByCapture,
    int SampleRate,
    int Channels);

/// <summary>
/// Loopback audio, encoded to Opus on a fixed clock.
///
/// The clock is the point. WASAPI delivers nothing at all while a PC is silent, so a
/// pipeline paced by arriving packets would stop producing audio the moment the music
/// stopped and never restart cleanly — and a receiver whose jitter buffer starves takes a
/// second or more to recover once sound returns. Instead this runs on its own 20 ms clock
/// and encodes whatever the capture had, padding with silence. Opus in discontinuous mode
/// turns those silent frames into a few bytes each, so continuity costs almost nothing.
///
/// 20 ms is the WebRTC default and what every browser expects; other sizes work but nothing
/// is gained by being unusual on a path this well trodden.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class AudioPipeline : IDisposable
{
    /// <summary>Opus is defined at these rates; anything else has to be resampled first.</summary>
    public const int OpusSampleRate = 48000;

    /// <summary>Channels sent. Stereo, because a desktop's audio usually is.</summary>
    public const int OpusChannels = 2;

    /// <summary>Frame duration. 20 ms at 48 kHz is 960 samples per channel.</summary>
    public static readonly TimeSpan FrameDuration = TimeSpan.FromMilliseconds(20);

    private const int SamplesPerFrame = OpusSampleRate / 1000 * 20;

    private readonly AudioLoopbackCapture _capture;
    private readonly IOpusEncoder _encoder;
    private readonly IResampler? _resampler;
    private readonly Action<EncodedAudioFrame> _onFrame;
    private readonly ILogger<AudioPipeline> _logger;
    private readonly CancellationTokenSource _stopping = new();
    private readonly Thread _thread;

    private readonly float[] _captured;
    private readonly short[] _pcm = new short[SamplesPerFrame * OpusChannels];
    private readonly byte[] _packet = new byte[4000];

    // Resampling does not produce exactly one frame's worth per call — the ratio is rarely
    // whole — so what comes out is accumulated and drawn from in exact 20 ms frames.
    private readonly float[] _resampled;
    private readonly float[] _pending;
    private int _pendingCount;

    private long _framesEncoded;
    private long _framesSilent;
    private long _bytesEncoded;
    private bool _disposed;

    private AudioPipeline(
        AudioLoopbackCapture capture,
        IOpusEncoder encoder,
        IResampler? resampler,
        Action<EncodedAudioFrame> onFrame,
        ILogger<AudioPipeline> logger)
    {
        _capture = capture;
        _encoder = encoder;
        _resampler = resampler;
        _onFrame = onFrame;
        _logger = logger;

        // Sized for the device's rate and channel count, which is what the capture produces.
        _captured = new float[capture.SampleRate / 1000 * 20 * capture.Channels];

        // Room for more than one frame in each, so a resampler that runs slightly ahead has
        // somewhere to put the surplus rather than losing it.
        _resampled = new float[SamplesPerFrame * capture.Channels * 2];
        _pending = new float[SamplesPerFrame * capture.Channels * 4];

        _thread = new Thread(Run)
        {
            Name = "WOLF audio encode",
            IsBackground = true,
            Priority = ThreadPriority.AboveNormal,
        };
    }

    /// <summary>
    /// Start capturing and encoding, or return null if this PC has no audio to capture.
    ///
    /// A null here is reported to the client as audio being unavailable. It is not a stream
    /// failure: the picture is the point, and a machine with no audio endpoint should still
    /// be watchable.
    /// </summary>
    public static AudioPipeline? TryStart(
        int bitrateBitsPerSecond,
        Action<EncodedAudioFrame> onFrame,
        ILoggerFactory loggers)
    {
        AudioLoopbackCapture? capture = AudioLoopbackCapture.TryStart(
            loggers.CreateLogger<AudioLoopbackCapture>());

        if (capture is null) return null;

        ILogger<AudioPipeline> logger = loggers.CreateLogger<AudioPipeline>();

        try
        {
            IOpusEncoder encoder = OpusCodecFactory.CreateEncoder(
                OpusSampleRate,
                OpusChannels,
                // Desktop audio is as often music or a video as it is speech, so the
                // general audio mode is the honest choice; the voice modes would mangle
                // anything that is not talking.
                OpusApplication.OPUS_APPLICATION_AUDIO);

            encoder.Bitrate = Math.Clamp(bitrateBitsPerSecond, 16_000, 256_000);

            // Discontinuous transmission: silence becomes a handful of bytes rather than a
            // full frame. On a desktop that is quiet most of the time, this is the
            // difference between audio costing nothing and audio costing a constant 96 kbps.
            encoder.UseDTX = true;

            // In-band forward error correction, so a lost packet degrades rather than gaps.
            encoder.UseInbandFEC = true;
            encoder.PacketLossPercent = 5;

            IResampler? resampler = capture.SampleRate == OpusSampleRate
                ? null
                : ResamplerFactory.CreateResampler(capture.Channels, capture.SampleRate, OpusSampleRate, 5);

            if (resampler is not null)
            {
                logger.LogInformation(
                    "Resampling audio from {DeviceRate} Hz to {OpusRate} Hz for Opus.",
                    capture.SampleRate,
                    OpusSampleRate);
            }

            var pipeline = new AudioPipeline(capture, encoder, resampler, onFrame, logger);
            pipeline._thread.Start();

            logger.LogInformation(
                "Audio pipeline started: Opus at {Kbps} kbps, {Rate} Hz stereo, 20 ms frames.",
                encoder.Bitrate / 1000,
                OpusSampleRate);

            return pipeline;
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException)
        {
            logger.LogError(ex, "The Opus encoder could not be created; this stream will have no audio.");
            capture.Dispose();
            return null;
        }
    }

    public AudioStats Stats() => new(
        Interlocked.Read(ref _framesEncoded),
        Interlocked.Read(ref _framesSilent),
        Interlocked.Read(ref _bytesEncoded),
        _capture.FramesDropped,
        OpusSampleRate,
        OpusChannels);

    /// <summary>Change the target bitrate on the running encoder.</summary>
    public void SetBitrate(int bitsPerSecond)
    {
        _encoder.Bitrate = Math.Clamp(bitsPerSecond, 16_000, 256_000);
    }

    private void Run()
    {
        long nextTick = Stopwatch.GetTimestamp();
        long interval = (long)(FrameDuration.TotalSeconds * Stopwatch.Frequency);

        while (!_stopping.IsCancellationRequested)
        {
            long now = Stopwatch.GetTimestamp();
            if (now < nextTick)
            {
                var remaining = TimeSpan.FromSeconds((nextTick - now) / (double)Stopwatch.Frequency);
                Thread.Sleep(remaining > TimeSpan.FromMilliseconds(2)
                    ? remaining - TimeSpan.FromMilliseconds(1)
                    : TimeSpan.Zero);
                continue;
            }

            nextTick += interval;

            try
            {
                EncodeOneFrame();
            }
            catch (Exception ex)
            {
                // One bad frame must not end the audio. The stream continues, silent for an
                // interval, which is far better than a stream that stops making sound.
                _logger.LogError(ex, "An audio frame could not be encoded.");
            }
        }
    }

    private void EncodeOneFrame()
    {
        int wanted = _captured.Length;
        int read = _capture.Read(_captured.AsSpan(0, wanted));

        // Whatever the capture did not have is silence. A PC playing nothing produces no
        // samples at all, and this is where that becomes a continuous stream again.
        if (read < wanted) Array.Clear(_captured, read, wanted - read);

        bool silent = read == 0;

        ToStereoPcm(AtOpusRate(), _capture.Channels, _pcm);

        int length = _encoder.Encode(_pcm, SamplesPerFrame, _packet, _packet.Length);

        // Discontinuous transmission answers a silent frame with nothing at all, which is
        // the point of it — there is simply no packet to send.
        if (length <= 2)
        {
            Interlocked.Increment(ref _framesSilent);
            if (length <= 0) return;
        }

        var frame = new byte[length];
        Array.Copy(_packet, frame, length);

        Interlocked.Increment(ref _framesEncoded);
        Interlocked.Add(ref _bytesEncoded, length);

        _onFrame(new EncodedAudioFrame(frame, FrameDuration, silent));
    }

    /// <summary>
    /// One frame of audio at Opus's rate, resampling if the device runs at another.
    ///
    /// Opus accepts 8, 12, 16, 24, and 48 kHz and nothing else, and Windows lets the user
    /// pick the endpoint's mix rate — 44.1 kHz is a common choice. Encoding 44.1 kHz samples
    /// as though they were 48 kHz would play back a few percent slow and a semitone flat,
    /// which sounds like a broken stream rather than a configuration mismatch.
    /// </summary>
    private ReadOnlySpan<float> AtOpusRate()
    {
        if (_resampler is null) return _captured;

        int channels = _capture.Channels;
        int inputFrames = _captured.Length / channels;
        int outputFrames = (_resampled.Length - 1) / channels;

        _resampler.ProcessInterleaved(_captured, ref inputFrames, _resampled, ref outputFrames);

        int produced = outputFrames * channels;
        int room = _pending.Length - _pendingCount;

        if (produced > room)
        {
            // The accumulator only overruns if the consumer stalled. Dropping the oldest
            // audio keeps the stream in step with the picture instead of falling behind it.
            int discard = produced - room;
            Array.Copy(_pending, discard, _pending, 0, _pendingCount - discard);
            _pendingCount -= discard;
        }

        Array.Copy(_resampled, 0, _pending, _pendingCount, produced);
        _pendingCount += produced;

        int frame = SamplesPerFrame * channels;
        if (_pendingCount < frame)
        {
            // Not a full frame yet, which happens on the first interval and after a gap.
            // The rest is silence rather than a short frame Opus would refuse.
            Array.Clear(_pending, _pendingCount, frame - _pendingCount);
            _pendingCount = frame;
        }

        Array.Copy(_pending, 0, _captured, 0, Math.Min(frame, _captured.Length));
        Array.Copy(_pending, frame, _pending, 0, _pendingCount - frame);
        _pendingCount -= frame;

        return _captured;
    }

    /// <summary>
    /// Interleaved device float to interleaved stereo 16-bit, which is what Opus takes.
    ///
    /// Mono is duplicated to both channels rather than sent as mono, so the negotiated
    /// format never changes mid-stream. More than two channels keeps the front pair: a
    /// proper downmix of a surround stream is a different problem, and silently folding a
    /// centre channel into both sides would change what the operator hears.
    /// </summary>
    private static void ToStereoPcm(ReadOnlySpan<float> source, int channels, Span<short> destination)
    {
        int frames = destination.Length / OpusChannels;

        for (int frame = 0; frame < frames; frame++)
        {
            int offset = frame * channels;
            float left = offset < source.Length ? source[offset] : 0;
            float right = channels > 1 && offset + 1 < source.Length ? source[offset + 1] : left;

            destination[frame * 2] = ToPcm(left);
            destination[frame * 2 + 1] = ToPcm(right);
        }
    }

    /// <summary>
    /// Float to 16-bit, clamped.
    ///
    /// Windows mixes in float and does not guarantee the result stays inside ±1: a loud
    /// application can push it past, and letting that wrap round produces a burst of noise
    /// at exactly the moment somebody turned the volume up.
    /// </summary>
    private static short ToPcm(float sample) =>
        (short)(Math.Clamp(sample, -1f, 1f) * short.MaxValue);

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        _stopping.Cancel();
        _thread.Join(TimeSpan.FromSeconds(2));

        _capture.Dispose();
        _resampler?.Dispose();
        _stopping.Dispose();

        _logger.LogInformation(
            "Audio pipeline stopped after {Frames} frames ({Silent} silent, {Kb} KB).",
            Interlocked.Read(ref _framesEncoded),
            Interlocked.Read(ref _framesSilent),
            Interlocked.Read(ref _bytesEncoded) / 1024);
    }
}
