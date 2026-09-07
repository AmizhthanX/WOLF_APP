using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Microsoft.Extensions.Logging;

namespace Wolf.Agent.SessionHost.Audio;

/// <summary>
/// What the PC is playing, as it plays it.
///
/// This is **loopback** capture: the samples going to the speakers, not the microphone. That
/// distinction is the whole privacy story of the feature. An operator watching a remote
/// desktop hears the video that is playing on it and the sound its applications make; they
/// do not hear the room the PC is sitting in. Microphone capture would be a different
/// feature with a different consent question, and WOLF does not have it.
///
/// Two behaviours of WASAPI shape everything downstream:
///
///  * **A silent PC delivers no packets at all**, not packets of silence. Anything that
///    treated an empty read as a fault would report a broken stream on a quiet machine, and
///    anything that paced itself off arriving packets would stop producing audio entirely.
///    The encoder above therefore runs on its own clock and fills gaps with silence.
///  * **The device chooses the format.** It is 48 kHz stereo float on most machines, which
///    is exactly what Opus wants, but nothing guarantees it — so the format is read rather
///    than assumed, and converted where it differs.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class AudioLoopbackCapture : IDisposable
{
    /// <summary>
    /// Samples held for the encoder to collect.
    ///
    /// Half a second. Large enough to absorb a scheduling hiccup, small enough that a
    /// consumer which stalls drops old audio rather than accumulating a growing delay —
    /// late audio is worse than missing audio, because it desynchronises from the picture.
    /// </summary>
    private const int BufferSeconds = 1;

    private readonly IAudioClient _client;
    private readonly IAudioCaptureClient _capture;
    private readonly ILogger<AudioLoopbackCapture> _logger;
    private readonly Thread _thread;
    private readonly CancellationTokenSource _stopping = new();
    private readonly object _gate = new();

    private readonly float[] _ring;
    private int _writeIndex;
    private int _available;

    private long _framesCaptured;
    private long _framesDropped;
    private bool _disposed;

    private AudioLoopbackCapture(
        IAudioClient client,
        IAudioCaptureClient capture,
        int sampleRate,
        int channels,
        ILogger<AudioLoopbackCapture> logger)
    {
        _client = client;
        _capture = capture;
        SampleRate = sampleRate;
        Channels = channels;
        _logger = logger;
        _ring = new float[sampleRate * channels * BufferSeconds];

        _thread = new Thread(Run)
        {
            Name = "WOLF audio capture",
            IsBackground = true,
            // Above normal, like the capture thread: audio that arrives late cannot be used,
            // and the work per wake-up is a memory copy.
            Priority = ThreadPriority.AboveNormal,
        };
    }

    public int SampleRate { get; }

    public int Channels { get; }

    public long FramesCaptured => Interlocked.Read(ref _framesCaptured);

    /// <summary>Frames discarded because nothing collected them in time.</summary>
    public long FramesDropped => Interlocked.Read(ref _framesDropped);

    /// <summary>
    /// Open the default output device in loopback mode, or return null with the reason
    /// logged.
    ///
    /// Null is a normal outcome, not a crash: a machine with no audio endpoint at all — a
    /// server, a VM without an audio driver — simply cannot do this, and the stream says so
    /// rather than failing to start.
    /// </summary>
    public static AudioLoopbackCapture? TryStart(ILogger<AudioLoopbackCapture> logger)
    {
        IntPtr mixFormat = IntPtr.Zero;

        try
        {
            var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
            enumerator.GetDefaultAudioEndpoint(0, 0, out IMMDevice device);

            Guid clientIid = typeof(IAudioClient).GUID;
            device.Activate(ref clientIid, WasapiConstants.ClsCtxInprocServer, IntPtr.Zero, out object clientObject);
            var client = (IAudioClient)clientObject;

            client.GetMixFormat(out mixFormat);
            WaveFormatEx format = Marshal.PtrToStructure<WaveFormatEx>(mixFormat);

            if (!IsFloat(format))
            {
                // Every Windows mix format since Vista has been 32-bit float. Converting
                // from an integer format is possible, but claiming to handle a case that has
                // never been seen would be untested code on a path nobody exercises.
                logger.LogWarning(
                    "The audio endpoint mixes at {Bits}-bit format {Tag}, which WOLF does not convert.",
                    format.BitsPerSample,
                    format.FormatTag);
                return null;
            }

            client.Initialize(
                WasapiConstants.ShareModeShared,
                WasapiConstants.StreamFlagsLoopback,
                WasapiConstants.OneSecond,
                0,
                mixFormat,
                IntPtr.Zero);

            Guid captureIid = typeof(IAudioCaptureClient).GUID;
            client.GetService(ref captureIid, out object captureObject);
            var capture = (IAudioCaptureClient)captureObject;

            var loopback = new AudioLoopbackCapture(
                client,
                capture,
                (int)format.SamplesPerSec,
                format.Channels,
                logger);

            client.Start();
            loopback._thread.Start();

            logger.LogInformation(
                "Audio loopback started: {Rate} Hz, {Channels} channel(s), 32-bit float.",
                format.SamplesPerSec,
                format.Channels);

            return loopback;
        }
        catch (COMException ex)
        {
            logger.LogWarning(ex, "This PC's audio endpoint could not be opened for loopback capture.");
            return null;
        }
        catch (InvalidCastException ex)
        {
            logger.LogWarning(ex, "The audio endpoint did not offer the interfaces WOLF needs.");
            return null;
        }
        finally
        {
            // GetMixFormat allocates with CoTaskMemAlloc and the caller owns it.
            if (mixFormat != IntPtr.Zero) Marshal.FreeCoTaskMem(mixFormat);
        }
    }

    /// <summary>
    /// Take up to <paramref name="destination"/>.Length samples of interleaved audio.
    ///
    /// Returns how many were actually available, which is routinely zero — a PC playing
    /// nothing produces nothing. The caller pads with silence rather than treating that as
    /// an error.
    /// </summary>
    public int Read(Span<float> destination)
    {
        lock (_gate)
        {
            int count = Math.Min(destination.Length, _available);
            if (count == 0) return 0;

            int start = (_writeIndex - _available + _ring.Length) % _ring.Length;
            int first = Math.Min(count, _ring.Length - start);

            _ring.AsSpan(start, first).CopyTo(destination);
            if (count > first) _ring.AsSpan(0, count - first).CopyTo(destination[first..]);

            _available -= count;
            return count;
        }
    }

    private void Run()
    {
        try
        {
            while (!_stopping.IsCancellationRequested)
            {
                _capture.GetNextPacketSize(out uint packetFrames);

                if (packetFrames == 0)
                {
                    // Nothing playing. Poll rather than block: WASAPI's event callback is
                    // not available on a loopback stream, and a silent machine would leave
                    // a blocking wait parked forever.
                    Thread.Sleep(5);
                    continue;
                }

                while (packetFrames > 0 && !_stopping.IsCancellationRequested)
                {
                    _capture.GetBuffer(out IntPtr data, out uint frames, out uint flags, out _, out _);

                    try
                    {
                        if (frames > 0)
                        {
                            // A silent buffer's contents are undefined, so it is written as
                            // zeroes rather than copied.
                            if ((flags & WasapiConstants.BufferFlagsSilent) != 0)
                            {
                                WriteSilence((int)frames * Channels);
                            }
                            else
                            {
                                unsafe
                                {
                                    Write(new ReadOnlySpan<float>((void*)data, (int)frames * Channels));
                                }
                            }

                            Interlocked.Add(ref _framesCaptured, frames);
                        }
                    }
                    finally
                    {
                        _capture.ReleaseBuffer(frames);
                    }

                    _capture.GetNextPacketSize(out packetFrames);
                }
            }
        }
        catch (COMException ex)
        {
            _logger.LogWarning(ex, "Audio capture stopped: the endpoint went away.");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "The audio capture thread failed.");
        }
    }

    private void Write(ReadOnlySpan<float> samples)
    {
        lock (_gate)
        {
            foreach (float sample in samples)
            {
                _ring[_writeIndex] = sample;
                _writeIndex = (_writeIndex + 1) % _ring.Length;
            }

            int overflow = _available + samples.Length - _ring.Length;
            if (overflow > 0)
            {
                // The consumer fell behind. Old audio is dropped rather than new: catching
                // up by playing stale sound would put it permanently behind the picture.
                Interlocked.Add(ref _framesDropped, overflow / Math.Max(1, Channels));
                _available = _ring.Length;
            }
            else
            {
                _available += samples.Length;
            }
        }
    }

    private void WriteSilence(int samples)
    {
        lock (_gate)
        {
            for (int index = 0; index < samples; index++)
            {
                _ring[_writeIndex] = 0;
                _writeIndex = (_writeIndex + 1) % _ring.Length;
            }

            _available = Math.Min(_ring.Length, _available + samples);
        }
    }

    private static bool IsFloat(WaveFormatEx format) =>
        format.BitsPerSample == 32 &&
        format.FormatTag is WasapiConstants.FormatIeeeFloat or WasapiConstants.FormatExtensible;

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        _stopping.Cancel();
        _thread.Join(TimeSpan.FromSeconds(2));

        try
        {
            _client.Stop();
        }
        catch (COMException)
        {
            // The endpoint is already gone.
        }

        if (Marshal.IsComObject(_capture)) Marshal.ReleaseComObject(_capture);
        if (Marshal.IsComObject(_client)) Marshal.ReleaseComObject(_client);

        _stopping.Dispose();

        _logger.LogDebug(
            "Audio capture released after {Frames} frames, {Dropped} dropped.",
            Interlocked.Read(ref _framesCaptured),
            Interlocked.Read(ref _framesDropped));
    }
}
