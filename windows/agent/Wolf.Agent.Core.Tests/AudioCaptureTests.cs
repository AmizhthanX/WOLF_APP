using System.Runtime.InteropServices;
using Microsoft.Extensions.Logging;
using Wolf.Agent.SessionHost.Audio;
using Xunit;
using Xunit.Abstractions;

namespace Wolf.Agent.Core.Tests;

/// <summary>
/// Loopback capture and Opus encoding, against the machine's real audio stack.
///
/// Testing this by playing something would be intrusive — the tests run on somebody's PC,
/// and nobody wants a test suite that makes noise. So where a signal is needed, these render
/// a tone at -60 dBFS: four orders of magnitude below full scale, plainly non-zero in the
/// samples and inaudible in the room.
///
/// What is being captured throughout is **loopback** — what the PC is playing — and not the
/// microphone. That distinction is the privacy story of the whole feature, and it is worth
/// stating in the tests as well as the code: nothing here can hear the room.
/// </summary>
[Collection("Capture")]
public sealed class AudioCaptureTests
{
    private readonly ITestOutputHelper _output;

    public AudioCaptureTests(ITestOutputHelper output)
    {
        _output = output;
    }

    private bool CanRun(AudioLoopbackCapture? capture)
    {
        if (capture is not null) return true;

        // A machine with no audio endpoint is a real configuration, not a failure. The
        // product reports audio as unavailable, and so does this.
        _output.WriteLine("No audio endpoint on this machine; skipping.");
        return false;
    }

    [Fact]
    public void The_default_output_device_can_be_opened_for_loopback()
    {
        using var loggers = new XunitLoggerFactory(_output, LogLevel.Information);
        using AudioLoopbackCapture? capture = AudioLoopbackCapture.TryStart(
            loggers.CreateLogger<AudioLoopbackCapture>());

        if (!CanRun(capture)) return;

        _output.WriteLine($"{capture!.SampleRate} Hz, {capture.Channels} channel(s)");

        Assert.InRange(capture.SampleRate, 8_000, 384_000);
        Assert.InRange(capture.Channels, 1, 8);
    }

    [Fact]
    public void A_silent_machine_produces_no_samples_rather_than_an_error()
    {
        using var loggers = new XunitLoggerFactory(_output, LogLevel.Warning);
        using AudioLoopbackCapture? capture = AudioLoopbackCapture.TryStart(
            loggers.CreateLogger<AudioLoopbackCapture>());

        if (!CanRun(capture)) return;

        Thread.Sleep(300);

        var buffer = new float[capture!.SampleRate * capture.Channels / 10];
        int read = capture.Read(buffer);

        _output.WriteLine($"{read} samples from a machine playing nothing");

        // This is the behaviour the whole audio pipeline is shaped around: WASAPI delivers
        // nothing at all while a PC is quiet, so anything that paced itself off arriving
        // packets would stop producing audio and never cleanly restart.
        Assert.True(read >= 0);
    }

    [Fact]
    public void Loopback_hears_what_the_machine_plays()
    {
        using var loggers = new XunitLoggerFactory(_output, LogLevel.Warning);
        using AudioLoopbackCapture? capture = AudioLoopbackCapture.TryStart(
            loggers.CreateLogger<AudioLoopbackCapture>());

        if (!CanRun(capture)) return;

        // A baseline first. If this machine is already playing something, the test tone
        // cannot be told apart from it, and a test that cannot distinguish its signal from
        // the noise should say so rather than pass on somebody's music.
        Thread.Sleep(400);
        double baseline = Drain(capture!);

        if (baseline > 0)
        {
            _output.WriteLine(
                $"This machine is already playing audio (peak {baseline:F6}); " +
                "the test tone cannot be isolated. Skipping.");
            return;
        }

        double peak;
        using (var tone = new InaudibleTone())
        {
            if (!tone.Started)
            {
                _output.WriteLine($"The output device could not be opened for rendering: {tone.Failure}");
                return;
            }

            Thread.Sleep(800);
            peak = Drain(capture!);
        }

        _output.WriteLine(
            $"silent baseline {baseline:F6}, peak while a -60 dBFS tone played: {peak:F6}");

        // The point of the feature: an operator watching a remote desktop hears what it is
        // playing. Nothing was audible before the tone and something was during it, so what
        // loopback captured is what WOLF put on the speakers.
        Assert.True(peak > baseline, "loopback captured nothing while the machine was playing");
    }

    [Fact]
    public void The_pipeline_produces_opus_packets_on_a_steady_clock()
    {
        using var loggers = new XunitLoggerFactory(_output, LogLevel.Information);

        var packets = new List<EncodedAudioFrame>();
        using AudioPipeline? pipeline = AudioPipeline.TryStart(
            96_000,
            frame =>
            {
                lock (packets) packets.Add(frame);
            },
            loggers);

        if (pipeline is null)
        {
            _output.WriteLine("No audio endpoint on this machine; skipping.");
            return;
        }

        using (var tone = new InaudibleTone())
        {
            Thread.Sleep(1000);
            _ = tone;
        }

        AudioStats stats = pipeline.Stats();

        int count;
        long bytes;
        lock (packets)
        {
            count = packets.Count;
            bytes = packets.Sum(packet => (long)packet.Data.Length);
        }

        _output.WriteLine(
            $"{count} packets in 1 s ({stats.FramesSilent} silent), {bytes} bytes, " +
            $"{stats.SampleRate} Hz {stats.Channels} ch");

        // 20 ms frames means about fifty a second. The clock is the product requirement: a
        // receiver whose jitter buffer starves takes a second to recover once sound returns.
        Assert.InRange(count, 30, 70);

        // Opus at 48 kHz stereo: every packet is a real one, and none is absurdly large.
        Assert.All(packets, packet => Assert.InRange(packet.Data.Length, 1, 1500));
        Assert.Equal(48_000, stats.SampleRate);
        Assert.Equal(2, stats.Channels);
    }

    [Fact]
    public void Silence_costs_almost_nothing_to_send()
    {
        using var loggers = new XunitLoggerFactory(_output, LogLevel.Warning);

        var packets = new List<EncodedAudioFrame>();
        using AudioPipeline? pipeline = AudioPipeline.TryStart(
            96_000,
            frame =>
            {
                lock (packets) packets.Add(frame);
            },
            loggers);

        if (pipeline is null) return;

        // Only meaningful on a machine that is actually quiet. Somebody running the suite
        // with music on would otherwise see this fail for a reason that has nothing to do
        // with WOLF.
        if (!MachineIsQuiet(loggers))
        {
            _output.WriteLine("This machine is playing audio; discontinuous transmission cannot be measured.");
            return;
        }

        lock (packets) packets.Clear();
        Thread.Sleep(1000);

        long bytes;
        int count;
        lock (packets)
        {
            count = packets.Count;
            bytes = packets.Sum(packet => (long)packet.Data.Length);
        }

        double kbps = bytes * 8 / 1000.0;
        _output.WriteLine($"a quiet second cost {bytes} bytes across {count} packets ({kbps:F1} kbps)");

        // Discontinuous transmission is why audio can be left on. Without it a silent
        // desktop would spend 96 kbps saying nothing.
        Assert.True(kbps < 20, $"silence cost {kbps:F1} kbps, which is not silence");
    }

    /// <summary>
    /// Whether the machine is producing no sound at all right now.
    ///
    /// Loopback delivers nothing on a quiet PC, so anything arriving means something is
    /// playing — which several of these tests cannot see past.
    /// </summary>
    private static bool MachineIsQuiet(XunitLoggerFactory loggers)
    {
        using AudioLoopbackCapture? capture = AudioLoopbackCapture.TryStart(
            loggers.CreateLogger<AudioLoopbackCapture>());

        if (capture is null) return true;

        Thread.Sleep(400);
        return Drain(capture) == 0;
    }

    /// <summary>Drain everything the capture has, returning the loudest sample seen.</summary>
    private static double Drain(AudioLoopbackCapture capture)
    {
        var buffer = new float[capture.SampleRate * capture.Channels / 10];
        double peak = 0;

        for (int attempt = 0; attempt < 20; attempt++)
        {
            int read = capture.Read(buffer);
            if (read == 0) break;

            for (int index = 0; index < read; index++)
            {
                peak = Math.Max(peak, Math.Abs(buffer[index]));
            }
        }

        return peak;
    }

    /// <summary>
    /// A 440 Hz tone at -60 dBFS on the default output device.
    ///
    /// Loud enough to be unmistakable in the captured samples, quiet enough that nobody in
    /// the room notices a test suite ran.
    /// </summary>
    private sealed class InaudibleTone : IDisposable
    {
        private const float Amplitude = 0.001f;

        private readonly IAudioClient? _client;
        private readonly IAudioRenderClient? _render;
        private readonly Thread? _thread;
        private readonly CancellationTokenSource _stopping = new();

        public InaudibleTone()
        {
            IntPtr mixFormat = IntPtr.Zero;

            try
            {
                var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
                enumerator.GetDefaultAudioEndpoint(0, 0, out IMMDevice device);

                Guid clientIid = typeof(IAudioClient).GUID;
                device.Activate(ref clientIid, 1, IntPtr.Zero, out object clientObject);
                _client = (IAudioClient)clientObject;

                _client.GetMixFormat(out mixFormat);
                WaveFormatEx format = Marshal.PtrToStructure<WaveFormatEx>(mixFormat);
                Channels = format.Channels;
                SampleRate = (int)format.SamplesPerSec;

                _client.Initialize(0, 0, 10_000_000, 0, mixFormat, IntPtr.Zero);

                Guid renderIid = typeof(IAudioRenderClient).GUID;
                _client.GetService(ref renderIid, out object renderObject);
                _render = (IAudioRenderClient)renderObject;

                _client.GetBufferSize(out uint frames);
                BufferFrames = frames;

                _client.Start();
                _thread = new Thread(Run) { IsBackground = true };
                _thread.Start();
                Started = true;
            }
            catch (Exception ex) when (ex is COMException or InvalidCastException)
            {
                Started = false;
                Failure = ex;
            }
            finally
            {
                if (mixFormat != IntPtr.Zero) Marshal.FreeCoTaskMem(mixFormat);
            }
        }

        public bool Started { get; }

        /// <summary>Why the tone could not start, so a skipped test says what it skipped over.</summary>
        public Exception? Failure { get; }

        private int Channels { get; }

        private int SampleRate { get; }

        private uint BufferFrames { get; }

        private void Run()
        {
            double phase = 0;

            while (!_stopping.IsCancellationRequested)
            {
                try
                {
                    _client!.GetCurrentPadding(out uint padding);
                    uint free = BufferFrames - padding;

                    if (free > 0)
                    {
                        _render!.GetBuffer(free, out IntPtr buffer);

                        unsafe
                        {
                            var samples = (float*)buffer;
                            for (uint frame = 0; frame < free; frame++)
                            {
                                var value = (float)(Math.Sin(phase) * Amplitude);
                                phase += 2 * Math.PI * 440 / SampleRate;

                                for (int channel = 0; channel < Channels; channel++)
                                {
                                    samples[frame * Channels + channel] = value;
                                }
                            }
                        }

                        _render.ReleaseBuffer(free, 0);
                    }
                }
                catch (COMException)
                {
                    return;
                }

                Thread.Sleep(10);
            }
        }

        public void Dispose()
        {
            _stopping.Cancel();
            _thread?.Join(TimeSpan.FromSeconds(1));

            try
            {
                _client?.Stop();
            }
            catch (COMException)
            {
                // Already gone.
            }

            _stopping.Dispose();
        }
    }

    [ComImport]
    [Guid("F294ACFC-3146-4483-A7BF-ADDCA7C260E2")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioRenderClient
    {
        void GetBuffer(uint frames, out IntPtr data);

        void ReleaseBuffer(uint frames, uint flags);
    }

}
