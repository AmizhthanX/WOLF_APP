using System.Diagnostics;
using Microsoft.Extensions.Logging.Abstractions;
using Wolf.Agent.SessionHost.Capture;
using Wolf.Agent.SessionHost.Displays;
using Wolf.Agent.SessionHost.Encoding;
using Xunit;
using Xunit.Abstractions;

namespace Wolf.Agent.Core.Tests;

/// <summary>
/// The capture-to-H.264 pipeline, running on the real GPU.
///
/// The assertions parse the encoder's output as an H.264 byte stream rather than checking
/// that some bytes came back. That distinction matters: an encoder can be misconfigured in
/// ways that produce plausible-looking output a decoder cannot read — wrong start codes, no
/// parameter sets, no key frame — and every one of those failures would look like success
/// to a test that only counted bytes.
/// </summary>
[Collection("Capture")]
public sealed class EncodePipelineTests
{
    private readonly ITestOutputHelper _output;

    public EncodePipelineTests(ITestOutputHelper output)
    {
        _output = output;
    }

    /// <summary>NAL unit types an H.264 stream must contain for a decoder to start.</summary>
    private const int NalSlice = 1;
    private const int NalIdr = 5;
    private const int NalSps = 7;
    private const int NalPps = 8;

    /// <summary>
    /// Split an Annex-B byte stream into NAL units.
    ///
    /// Written out rather than trusted: this is the check that the encoder produced a real
    /// elementary stream and not, say, length-prefixed AVCC, which would look like data but
    /// would be undecodable by the RTP packetiser this feeds.
    /// </summary>
    private static List<(int Type, int Length)> ParseNalUnits(byte[] data)
    {
        var units = new List<(int, int)>();
        var starts = new List<int>();

        for (int index = 0; index + 3 < data.Length; index++)
        {
            bool fourByte = data[index] == 0 && data[index + 1] == 0 && data[index + 2] == 0 && data[index + 3] == 1;
            bool threeByte = data[index] == 0 && data[index + 1] == 0 && data[index + 2] == 1;

            if (fourByte)
            {
                starts.Add(index + 4);
                index += 3;
            }
            else if (threeByte)
            {
                starts.Add(index + 3);
                index += 2;
            }
        }

        for (int i = 0; i < starts.Count; i++)
        {
            int start = starts[i];
            int end = i + 1 < starts.Count ? starts[i + 1] : data.Length;
            if (start < data.Length)
            {
                units.Add((data[start] & 0x1F, end - start));
            }
        }

        return units;
    }

    private sealed record PipelineResult(
        List<EncodedVideoFrame> Frames,
        string EncoderName,
        bool Hardware,
        bool Async,
        byte[] ParameterSets,
        int CapturedFrames,
        long ElapsedMs);

    /// <summary>Run the whole pipeline for a short burst, or return null if it cannot start.</summary>
    private PipelineResult? RunPipeline(int targetFrames, int bitrate = 8_000_000)
    {
        // Real logging, not NullLogger: when a GPU or a driver refuses something, the reason
        // is in these messages and nowhere else.
        using var loggers = new XunitLoggerFactory(_output);
        var enumerator = new DisplayEnumerator(NullLogger<DisplayEnumerator>.Instance);
        if (enumerator.Enumerate().Count == 0 || !CaptureDevice.IsCaptureSupported())
        {
            _output.WriteLine("No desktop or no capture support in this session; skipping.");
            return null;
        }

        IntPtr? monitor = DisplayEnumerator.FindPrimaryMonitorHandle();
        if (monitor is null) return null;

        using CaptureDevice? device = CaptureDevice.TryCreate(loggers.CreateLogger<CaptureDevice>());
        Assert.NotNull(device);

        using DisplayCapture? capture = DisplayCapture.TryStart(
            device!,
            monitor.Value,
            loggers.CreateLogger<DisplayCapture>());
        Assert.NotNull(capture);

        const int frameRate = 30;

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
            new EncoderSettings(capture.Width, capture.Height, frameRate, bitrate),
            loggers.CreateLogger<H264Encoder>());
        Assert.NotNull(encoder);

        var frames = new List<EncodedVideoFrame>();
        var stopwatch = Stopwatch.StartNew();
        var captured = 0;
        TimeSpan timestamp = TimeSpan.Zero;
        TimeSpan step = TimeSpan.FromSeconds(1.0 / frameRate);

        while (stopwatch.Elapsed < TimeSpan.FromSeconds(15) && frames.Count < targetFrames)
        {
            using CaptureFrameLease? lease = capture.TryAcquire();
            if (lease is null)
            {
                Thread.Sleep(2);
                continue;
            }

            captured++;
            if (!converter!.Convert(lease.Frame.Texture)) continue;

            encoder!.Encode(converter.Output, timestamp, frames);
            timestamp += step;
        }

        stopwatch.Stop();

        return new PipelineResult(
            frames,
            encoder!.EncoderName,
            encoder.IsHardware,
            encoder.IsAsync,
            encoder.ParameterSets,
            captured,
            stopwatch.ElapsedMilliseconds);
    }

    [Fact]
    public void The_pipeline_produces_a_decodable_h264_stream()
    {
        PipelineResult? result = RunPipeline(targetFrames: 30);
        if (result is null) return;

        _output.WriteLine(
            $"encoder: {result.EncoderName} (hardware={result.Hardware}, async={result.Async})");
        _output.WriteLine(
            $"captured {result.CapturedFrames} frames, encoded {result.Frames.Count} in {result.ElapsedMs} ms");
        _output.WriteLine($"parameter sets: {result.ParameterSets.Length} bytes");

        Assert.True(result.Frames.Count > 0, "the encoder produced no output at all");

        long totalBytes = result.Frames.Sum(frame => (long)frame.Data.Length);
        _output.WriteLine(
            $"total {totalBytes} bytes, mean {totalBytes / result.Frames.Count} bytes/frame");

        // Every frame must be a well-formed Annex-B stream, or the RTP packetiser downstream
        // has nothing it can split on.
        foreach (EncodedVideoFrame frame in result.Frames)
        {
            Assert.True(frame.Data.Length > 0, "an encoded frame was empty");
            List<(int Type, int Length)> units = ParseNalUnits(frame.Data);
            Assert.True(units.Count > 0, "an encoded frame contained no NAL start codes");
        }

        // Across the opening frames, a decoder needs a sequence parameter set, a picture
        // parameter set, and an IDR before it can render anything.
        List<(int Type, int Length)> opening = result.Frames
            .Take(5)
            .SelectMany(frame => ParseNalUnits(frame.Data))
            .ToList();

        _output.WriteLine(
            "opening NAL types: " + string.Join(", ", opening.Select(unit => unit.Type).Distinct().Order()));

        Assert.Contains(opening, unit => unit.Type == NalSps);
        Assert.Contains(opening, unit => unit.Type == NalPps);
        Assert.Contains(opening, unit => unit.Type == NalIdr);
    }

    [Fact]
    public void The_first_frame_is_a_key_frame_so_a_client_can_start_immediately()
    {
        PipelineResult? result = RunPipeline(targetFrames: 10);
        if (result is null) return;

        Assert.NotEmpty(result.Frames);

        EncodedVideoFrame first = result.Frames[0];
        _output.WriteLine($"first frame: {first.Data.Length} bytes, keyFrame={first.IsKeyFrame}");

        Assert.True(first.IsKeyFrame, "a stream that opens on a delta frame shows nothing until the next key frame");
        Assert.Contains(ParseNalUnits(first.Data), unit => unit.Type is NalIdr or NalSps);
    }

    [Fact]
    public void Later_frames_are_smaller_than_the_key_frame()
    {
        PipelineResult? result = RunPipeline(targetFrames: 20);
        if (result is null || result.Frames.Count < 5) return;

        long keyFrameBytes = result.Frames[0].Data.Length;
        List<EncodedVideoFrame> delta = result.Frames.Skip(1).Where(frame => !frame.IsKeyFrame).ToList();

        if (delta.Count == 0)
        {
            _output.WriteLine("every frame was a key frame; nothing to compare.");
            return;
        }

        double meanDelta = delta.Average(frame => frame.Data.Length);
        _output.WriteLine($"key frame {keyFrameBytes} bytes, mean delta {meanDelta:F0} bytes");

        // A mostly-static desktop compresses hard between frames. If deltas were the same
        // size as the key frame, the encoder would be emitting every frame as an IDR, which
        // would waste most of the bitrate.
        Assert.True(
            meanDelta < keyFrameBytes,
            "delta frames are not smaller than the key frame, which suggests inter-frame prediction is off");
    }

    [Fact]
    public void Timestamps_advance_monotonically()
    {
        PipelineResult? result = RunPipeline(targetFrames: 15);
        if (result is null || result.Frames.Count < 3) return;

        // A decoder and an RTP packetiser both rely on this. Out-of-order or repeated
        // timestamps show up as stutter that is very hard to diagnose after the fact.
        for (int index = 1; index < result.Frames.Count; index++)
        {
            Assert.True(
                result.Frames[index].Timestamp >= result.Frames[index - 1].Timestamp,
                $"frame {index} went backwards in time");
        }
    }

    [Fact]
    public void A_lower_bitrate_produces_a_smaller_stream()
    {
        PipelineResult? high = RunPipeline(targetFrames: 20, bitrate: 20_000_000);
        PipelineResult? low = RunPipeline(targetFrames: 20, bitrate: 1_000_000);
        if (high is null || low is null || high.Frames.Count < 10 || low.Frames.Count < 10) return;

        double highMean = high.Frames.Average(frame => frame.Data.Length);
        double lowMean = low.Frames.Average(frame => frame.Data.Length);
        _output.WriteLine($"20 Mbps mean {highMean:F0} bytes, 1 Mbps mean {lowMean:F0} bytes");

        // The point of this test is that the bitrate setting reaches the encoder at all. A
        // configuration mistake here is invisible until someone on a slow link wonders why
        // the quality slider does nothing.
        Assert.True(lowMean < highMean, "the bitrate setting had no effect on the encoded size");
    }

    [Fact]
    public void A_bitrate_change_on_a_running_encoder_reaches_it_rather_than_being_swallowed()
    {
        // Adaptive streaming rests entirely on this: when the link degrades, WOLF lowers the
        // bitrate on the encoder that is already running. Codec properties are the one API
        // here that accepts anything and reports success regardless, so the value is read
        // back from the encoder instead of trusting the call that set it.
        using var loggers = new XunitLoggerFactory(_output);
        using CaptureDevice? device = CaptureDevice.TryCreate(loggers.CreateLogger<CaptureDevice>());
        if (device is null)
        {
            _output.WriteLine("No Direct3D device in this session; skipping.");
            return;
        }

        using H264Encoder? encoder = H264Encoder.TryCreate(
            device,
            new EncoderSettings(1280, 720, 30, 4_000_000),
            loggers.CreateLogger<H264Encoder>());
        Assert.NotNull(encoder);

        const int requested = 9_000_000;

        // Attempted regardless of what the encoder advertises, because the assertion below
        // is that the two agree. An encoder that claims the capability and then refuses is a
        // worse problem than one that never claimed it.
        bool accepted = encoder!.TrySetBitrate(requested);
        int? applied = encoder.ConfiguredBitrate();

        _output.WriteLine(
            $"{encoder.EncoderName}: advertises={encoder.SupportsBitrateChange}, " +
            $"accepted={accepted}, reports={applied?.ToString() ?? "nothing"}");

        if (!accepted)
        {
            // A real limitation of some encoders. The pipeline answers it by changing
            // resolution or frame rate instead, so this is reported, not failed — but the
            // capability flag must not have promised otherwise.
            Assert.False(
                encoder.SupportsBitrateChange,
                "the encoder advertised a live bitrate change and then refused one");
            return;
        }

        Assert.NotNull(applied);

        // Encoders are allowed to round to something they can actually deliver; they are not
        // allowed to ignore the request.
        Assert.InRange(applied!.Value, (int)(requested * 0.9), (int)(requested * 1.1));
    }
}
