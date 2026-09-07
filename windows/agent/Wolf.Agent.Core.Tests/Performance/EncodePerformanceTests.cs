using System.Diagnostics;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Wolf.Agent.SessionHost.Capture;
using Wolf.Agent.SessionHost.Displays;
using Wolf.Agent.SessionHost.Encoding;
using Xunit;
using Xunit.Abstractions;

namespace Wolf.Agent.Core.Tests.Performance;

/// <summary>
/// What capture and encode actually cost on this machine.
///
/// Measured against the real display and GPU, which is why these are tagged and excluded
/// from the ordinary suite: a hosted CI runner has neither, and running them there would
/// spend minutes measuring nothing. Run them with
/// <c>dotnet test --filter Category=Performance</c> on a machine with a screen.
///
/// The timings are instrumented here rather than read from the pipeline's own statistics.
/// The pipeline keeps a running mean, which is the wrong shape for this: a stream that
/// encodes in half a millisecond and then takes forty once a second feels broken while its
/// average looks excellent, so what matters is the tail.
/// </summary>
[Trait("Category", "Performance")]
[Collection("Capture")]
public sealed class EncodePerformanceTests
{
    private readonly ITestOutputHelper _output;

    public EncodePerformanceTests(ITestOutputHelper output)
    {
        _output = output;
    }

    /// <summary>Frames to measure. Enough for a stable ninety-ninth percentile.</summary>
    private const int SampleFrames = 300;

    private bool CanRun()
    {
        var displays = new DisplayEnumerator(NullLogger<DisplayEnumerator>.Instance);
        if (displays.Enumerate().Count > 0 && CaptureDevice.IsCaptureSupported()) return true;

        _output.WriteLine("No desktop or capture support here; a performance run needs a real screen.");
        return false;
    }

    [Fact]
    public void Encoding_a_frame_costs_less_than_the_frame_interval()
    {
        if (!CanRun()) return;

        using var loggers = new XunitLoggerFactory(_output, LogLevel.Warning);
        using CaptureDevice? device = CaptureDevice.TryCreate(loggers.CreateLogger<CaptureDevice>());
        Assert.NotNull(device);

        IntPtr? monitor = DisplayEnumerator.FindPrimaryMonitorHandle();
        using DisplayCapture? capture = DisplayCapture.TryStart(
            device!,
            monitor!.Value,
            loggers.CreateLogger<DisplayCapture>());
        Assert.NotNull(capture);

        const int frameRate = 60;

        using ColorConverter? converter = ColorConverter.TryCreate(
            device!,
            capture!.Width,
            capture.Height,
            capture.Width,
            capture.Height,
            frameRate,
            loggers.CreateLogger<ColorConverter>());
        Assert.NotNull(converter);

        using H264Encoder? encoder = H264Encoder.TryCreate(
            device!,
            new EncoderSettings(capture.Width, capture.Height, frameRate, 20_000_000),
            loggers.CreateLogger<H264Encoder>());
        Assert.NotNull(encoder);

        var convertMs = new List<double>(SampleFrames);
        var encodeMs = new List<double>(SampleFrames);
        var frameBytes = new List<int>(SampleFrames);
        var frames = new List<EncodedVideoFrame>(4);

        var overall = Stopwatch.StartNew();
        TimeSpan timestamp = TimeSpan.Zero;
        TimeSpan step = TimeSpan.FromSeconds(1.0 / frameRate);
        var captured = 0;

        while (encodeMs.Count < SampleFrames && overall.Elapsed < TimeSpan.FromSeconds(30))
        {
            using CaptureFrameLease? lease = capture.TryAcquire();
            if (lease is null)
            {
                Thread.Sleep(1);
                continue;
            }

            captured++;

            long convertStart = Stopwatch.GetTimestamp();
            bool converted = converter!.Convert(lease.Frame.Texture);
            convertMs.Add(Milliseconds(convertStart));

            if (!converted) continue;

            frames.Clear();
            long encodeStart = Stopwatch.GetTimestamp();
            encoder!.Encode(converter.Output, timestamp, frames);
            double elapsed = Milliseconds(encodeStart);

            timestamp += step;

            // The encoder buffers: a call that produced nothing did work anyway, and one
            // that produced two frames did not do twice the work. Timing is attributed per
            // call, and only calls that yielded a picture are counted, so the number means
            // "what one frame cost" rather than "what one call took".
            if (frames.Count == 0) continue;

            encodeMs.Add(elapsed);
            foreach (EncodedVideoFrame frame in frames) frameBytes.Add(frame.Data.Length);
        }

        overall.Stop();

        if (encodeMs.Count < 30)
        {
            // A still screen produces almost no frames. Reporting a percentile over a
            // handful of samples would be arithmetic, not measurement.
            _output.WriteLine(
                $"Only {encodeMs.Count} frames in {overall.ElapsedMilliseconds} ms — the screen is " +
                "not changing enough to measure encode performance. Skipping.");
            return;
        }

        double meanEncode = encodeMs.Average();
        double p50 = Percentile(encodeMs, 0.50);
        double p95 = Percentile(encodeMs, 0.95);
        double p99 = Percentile(encodeMs, 0.99);
        double achievedFps = encodeMs.Count / overall.Elapsed.TotalSeconds;

        _output.WriteLine($"encoder      {encoder!.EncoderName} ({(encoder.IsHardware ? "hardware" : "software")})");
        _output.WriteLine($"resolution   {capture.Width}x{capture.Height} at a {frameRate} fps target");
        _output.WriteLine($"captured     {captured} frames, encoded {encodeMs.Count} in {overall.ElapsedMilliseconds} ms ({achievedFps:F1} fps)");
        _output.WriteLine($"convert      mean {convertMs.Average():F2} ms, p99 {Percentile(convertMs, 0.99):F2} ms");
        _output.WriteLine($"encode       mean {meanEncode:F2} ms, p50 {p50:F2}, p95 {p95:F2}, p99 {p99:F2} ms");
        _output.WriteLine($"frame size   mean {frameBytes.Average() / 1024.0:F1} KB, largest {frameBytes.Max() / 1024.0:F1} KB");
        _output.WriteLine($"budget       mean < {PerformanceBudgets.MeanEncodeMsAt60Fps} ms, p99 < {PerformanceBudgets.P99EncodeMsAt60Fps} ms");

        Assert.True(
            meanEncode < PerformanceBudgets.MeanEncodeMsAt60Fps,
            $"mean encode {meanEncode:F2} ms against a {PerformanceBudgets.MeanEncodeMsAt60Fps} ms budget");

        // The tail is the number that decides whether a stream feels smooth.
        Assert.True(
            p99 < PerformanceBudgets.P99EncodeMsAt60Fps,
            $"99th percentile encode {p99:F2} ms against a {PerformanceBudgets.P99EncodeMsAt60Fps} ms budget");
    }

    [Fact]
    public void The_pipeline_sustains_its_frame_rate_on_a_changing_screen()
    {
        if (!CanRun()) return;

        using var loggers = new XunitLoggerFactory(_output, LogLevel.Warning);
        using CaptureDevice? device = CaptureDevice.TryCreate(loggers.CreateLogger<CaptureDevice>());
        IntPtr? monitor = DisplayEnumerator.FindPrimaryMonitorHandle();

        var arrivals = new List<long>();
        using CapturePipeline? pipeline = CapturePipeline.TryCreate(
            device!,
            monitor!.Value,
            60,
            20_000_000,
            _ =>
            {
                lock (arrivals) arrivals.Add(Stopwatch.GetTimestamp());
            },
            loggers);
        Assert.NotNull(pipeline);

        pipeline!.Start();

        // Something has to be moving for Graphics Capture to produce frames at all, so the
        // measurement drives the screen itself rather than hoping somebody is using it.
        using var painter = new ScreenActivity();
        Thread.Sleep(TimeSpan.FromSeconds(5));

        PipelineStats stats = pipeline.Stats();
        long[] samples;
        lock (arrivals) samples = arrivals.ToArray();

        if (samples.Length < 30)
        {
            _output.WriteLine($"Only {samples.Length} frames arrived; nothing is changing on screen. Skipping.");
            return;
        }

        // Gaps between deliveries, which is what a viewer actually experiences.
        var gaps = new List<double>(samples.Length - 1);
        for (int index = 1; index < samples.Length; index++)
        {
            gaps.Add((samples[index] - samples[index - 1]) * 1000.0 / Stopwatch.Frequency);
        }

        _output.WriteLine($"captured     {stats.FramesCaptured} ({stats.CapturedFps:F1} fps)");
        _output.WriteLine($"encoded      {stats.FramesEncoded} ({stats.EncodedFps:F1} fps), dropped {stats.FramesDropped}");
        _output.WriteLine($"delivery gap mean {gaps.Average():F1} ms, p95 {Percentile(gaps, 0.95):F1}, worst {gaps.Max():F1} ms");
        _output.WriteLine($"throughput   {stats.BytesEncoded / 1024.0 / 1024.0:F1} MB in 5 s");

        Assert.Equal(0, stats.FramesDropped);
        Assert.True(
            stats.EncodedFps >= PerformanceBudgets.MinimumSustainedFps,
            $"sustained {stats.EncodedFps:F1} fps against a {PerformanceBudgets.MinimumSustainedFps} fps floor");
    }

    private static double Milliseconds(long since) =>
        (Stopwatch.GetTimestamp() - since) * 1000.0 / Stopwatch.Frequency;

    /// <summary>
    /// The value below which the given share of samples falls.
    ///
    /// Nearest-rank, which is the definition that does not invent a number no sample had.
    /// </summary>
    internal static double Percentile(IReadOnlyList<double> samples, double share)
    {
        double[] sorted = samples.OrderBy(value => value).ToArray();
        int rank = (int)Math.Ceiling(share * sorted.Length) - 1;
        return sorted[Math.Clamp(rank, 0, sorted.Length - 1)];
    }
}
