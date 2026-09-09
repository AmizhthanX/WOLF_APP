using System.Diagnostics;
using System.Runtime.Versioning;
using Microsoft.Extensions.Logging;
using Wolf.Agent.SessionHost.Encoding;

namespace Wolf.Agent.SessionHost.Capture;

/// <summary>
/// What the pipeline is currently achieving, as opposed to what it was asked for.
///
/// The three rates are measured over the last second, not since the stream started. That
/// distinction is the whole point of them: both things that read these numbers — the
/// adaptation controller, and the operator looking at the statistics panel — are asking
/// "what is happening now". A lifetime mean answers a question nobody asked, and answers it
/// misleadingly the moment anything changes: a stream taken from 30 fps to 15 reports
/// neither, drifting between them for minutes, and an encoder that has just started
/// struggling is hidden by every healthy second that came before it.
///
/// The counts beside them are lifetime totals, which is what a count should be.
/// </summary>
public sealed record PipelineStats(
    /// <summary>Frames captured per second, over the last window.</summary>
    double CapturedFps,
    /// <summary>Frames encoded per second, over the last window.</summary>
    double EncodedFps,
    long FramesCaptured,
    long FramesEncoded,
    long FramesDropped,
    long BytesEncoded,
    /// <summary>Milliseconds per encode call, over the last window.</summary>
    double MeanEncodeMs,
    int WidthPixels,
    int HeightPixels,
    string Encoder,
    bool HardwareEncoded);

/// <summary>
/// Capture, convert, encode — on one thread, at a controlled rate.
///
/// A display refreshing at 165 Hz will hand over frames far faster than any stream needs, so
/// the pipeline paces itself to the requested frame rate and simply does not collect the
/// frames in between. Pacing here rather than encoding everything and discarding later is
/// what keeps the cost proportional to what is actually being sent.
///
/// It runs on a dedicated thread rather than the thread pool: this is a continuous
/// real-time job, and borrowing pool threads for it would both starve other work and
/// subject the frame cadence to pool scheduling.
/// </summary>
[SupportedOSPlatform("windows10.0.19041.0")]
public sealed class CapturePipeline : IDisposable
{
    private readonly CaptureDevice _device;
    private readonly ILoggerFactory _loggers;
    private readonly int _bitrateBitsPerSecond;

    // Rebuilt when the streamed display changes. Like the converter and encoder below, it is
    // only ever swapped on the pipeline thread, between frames.
    private DisplayCapture _capture;

    // Rebuilt when the encoded resolution changes, which is why they are not readonly. Both
    // are only ever swapped on the pipeline thread, between frames.
    private ColorConverter _converter;
    private H264Encoder _encoder;
    private readonly ILogger<CapturePipeline> _logger;
    /// <summary>
    /// Frames per second the pacing loop aims for.
    ///
    /// Adjustable while running: it is the second lever adaptation reaches for, after
    /// bitrate. The encoder keeps the frame rate it was configured with — reconfiguring it
    /// mid-stream costs a key frame — so feeding it fewer frames also lowers the bitrate it
    /// produces, which is the direction congestion wants anyway.
    /// </summary>
    private volatile int _targetFrameRate;
    private readonly Action<EncodedVideoFrame> _onFrame;

    private readonly CancellationTokenSource _stopping = new();
    private Thread? _thread;

    /// <summary>
    /// A change asked for from another thread, applied between frames.
    ///
    /// Both kinds go through one queue because they are the same operation underneath: a new
    /// converter and a new encoder, built before the old ones are torn down. Doing that from
    /// the caller's thread while the capture thread is mid-frame is how a pipeline ends up
    /// encoding from a texture that has been disposed.
    /// </summary>
    private (IntPtr? Monitor, int Width, int Height)? _pending;

    private IntPtr _monitorHandle;
    private readonly int _maxWidthPixels;
    private readonly int _maxHeightPixels;
    private long _framesCaptured;
    private long _framesEncoded;
    private long _bytesEncoded;
    private double _encodeMsTotal;

    /// <summary>
    /// How long a window the reported rates cover.
    ///
    /// One second, because adaptation observes on a one-second interval and a window longer
    /// than that would hand it the same number twice. Shorter, and a 15 fps stream would be
    /// measuring a handful of frames and reporting the noise.
    /// </summary>
    private const double WindowSeconds = 1.0;

    // Rolled forward on the capture thread; read under _running by Stats().
    private long _windowStartTicks;
    private long _windowCaptured;
    private long _windowEncoded;
    private double _windowEncodeMs;
    private long _windowEncodeCalls;
    private bool _windowMeasured;
    private double _recentCapturedFps;
    private double _recentEncodedFps;
    private double _recentEncodeMs;
    private readonly Stopwatch _running = new();
    private bool _disposed;

    private CapturePipeline(
        CaptureDevice device,
        DisplayCapture capture,
        ColorConverter converter,
        H264Encoder encoder,
        IntPtr monitorHandle,
        int targetFrameRate,
        int bitrateBitsPerSecond,
        int maxWidthPixels,
        int maxHeightPixels,
        Action<EncodedVideoFrame> onFrame,
        ILoggerFactory loggers,
        ILogger<CapturePipeline> logger)
    {
        _device = device;
        _capture = capture;
        _monitorHandle = monitorHandle;
        _maxWidthPixels = maxWidthPixels;
        _maxHeightPixels = maxHeightPixels;
        _converter = converter;
        _encoder = encoder;
        _targetFrameRate = targetFrameRate;
        _bitrateBitsPerSecond = bitrateBitsPerSecond;
        _onFrame = onFrame;
        _loggers = loggers;
        _logger = logger;
    }

    /// <summary>The monitor currently being captured.</summary>
    public IntPtr MonitorHandle => _monitorHandle;

    /// <summary>
    /// Raised when the captured display goes away — unplugged, or switched off.
    ///
    /// An event rather than a silent stop: a pipeline that simply ended would leave the
    /// viewer looking at a frozen picture with nothing to explain it, and the stream is
    /// perfectly capable of continuing on another display.
    /// </summary>
    public event Action? DisplayLost;

    /// <summary>The size of the display being captured.</summary>
    public int Width => _capture.Width;

    public int Height => _capture.Height;

    /// <summary>
    /// The size actually being encoded, which is what the client receives.
    ///
    /// Differs from the captured size whenever the stream is scaled — either because the
    /// profile capped it or because adaptation reached for its third lever.
    /// </summary>
    public int EncodedWidth => _converter.Width;

    public int EncodedHeight => _converter.Height;

    public string EncoderName => _encoder.EncoderName;

    public bool HardwareEncoded => _encoder.IsHardware;

    /// <summary>SPS and PPS, so a client can be given them without waiting for a key frame.</summary>
    public byte[] ParameterSets => _encoder.ParameterSets;

    /// <summary>
    /// Build the pipeline for one display, or return null with the reason already logged.
    ///
    /// Each stage is checked in turn — device, capture, converter, encoder — and any of them
    /// failing means this PC cannot stream, which is reported rather than retried.
    /// </summary>
    public static CapturePipeline? TryCreate(
        CaptureDevice device,
        IntPtr monitorHandle,
        int targetFrameRate,
        int bitrateBitsPerSecond,
        Action<EncodedVideoFrame> onFrame,
        ILoggerFactory loggers,
        int maxWidthPixels = 0,
        int maxHeightPixels = 0)
    {
        DisplayCapture? capture = DisplayCapture.TryStart(
            device,
            monitorHandle,
            loggers.CreateLogger<DisplayCapture>());
        if (capture is null) return null;

        // A profile that caps the resolution is honoured from the start rather than being
        // reported as a setting WOLF ignores. Zero means no cap.
        (int Width, int Height) encoded = maxWidthPixels > 0 && maxHeightPixels > 0
            ? FitWithin(capture.Width, capture.Height, maxWidthPixels, maxHeightPixels)
            : EvenSize(capture.Width, capture.Height);

        ColorConverter? converter = ColorConverter.TryCreate(
            device,
            capture.Width,
            capture.Height,
            encoded.Width,
            encoded.Height,
            targetFrameRate,
            loggers.CreateLogger<ColorConverter>());
        if (converter is null)
        {
            capture.Dispose();
            return null;
        }

        H264Encoder? encoder = H264Encoder.TryCreate(
            device,
            new EncoderSettings(encoded.Width, encoded.Height, targetFrameRate, bitrateBitsPerSecond),
            loggers.CreateLogger<H264Encoder>());
        if (encoder is null)
        {
            converter.Dispose();
            capture.Dispose();
            return null;
        }

        return new CapturePipeline(
            device,
            capture,
            converter,
            encoder,
            monitorHandle,
            targetFrameRate,
            bitrateBitsPerSecond,
            maxWidthPixels,
            maxHeightPixels,
            onFrame,
            loggers,
            loggers.CreateLogger<CapturePipeline>());
    }

    public void Start()
    {
        if (_thread is not null) return;

        _running.Start();
        _windowStartTicks = Stopwatch.GetTimestamp();
        _thread = new Thread(Run)
        {
            IsBackground = true,
            Name = "WOLF capture",
            // Above normal, not highest: a stream that stutters is bad, but a machine whose
            // input handling is starved by the thing streaming it is worse.
            Priority = ThreadPriority.AboveNormal,
        };
        _thread.Start();

        _logger.LogInformation(
            "Capture pipeline started: {Width}x{Height} at {Fps} fps via {Encoder}.",
            Width,
            Height,
            _targetFrameRate,
            _encoder.EncoderName);
    }

    /// <summary>Change the pacing target. Takes effect on the next frame.</summary>
    public void SetTargetFrameRate(int framesPerSecond)
    {
        int clamped = Math.Clamp(framesPerSecond, 1, 240);
        if (clamped == _targetFrameRate) return;

        _targetFrameRate = clamped;
        _logger.LogInformation("Pacing changed to {Fps} fps.", clamped);
    }

    /// <summary>The rate the pipeline is currently pacing to.</summary>
    public int TargetFrameRate => _targetFrameRate;

    /// <summary>
    /// Ask for a different encoded resolution.
    ///
    /// Queued rather than applied here: changing resolution means building a new converter
    /// and a new encoder, and doing that from another thread while the capture thread is
    /// mid-frame is how a pipeline ends up encoding from a texture that has been disposed.
    /// The change happens between frames, on the thread that owns them.
    ///
    /// This is adaptation's most expensive lever. The new encoder starts with a key frame
    /// and new parameter sets, so the client re-initialises its decoder and the operator
    /// sees the picture re-lay out — which is why it is the last thing reached for.
    /// </summary>
    public void RequestEncodedSize(int width, int height)
    {
        (int Width, int Height) target = EvenSize(width, height);
        if (target.Width == EncodedWidth && target.Height == EncodedHeight) return;

        if (_thread is null)
        {
            // Nothing is running yet, so no other thread owns the converter or the encoder
            // and the change can be made here. It has to be: a size asked for before the
            // stream starts is the size the negotiation must describe, and a queued change
            // would not reach EncodedWidth until the first frame — after the offer had gone
            // out claiming a different picture.
            try
            {
                Resize(target.Width, target.Height);
            }
            catch (Exception ex)
            {
                _logger.LogError(
                    ex,
                    "The encoded size could not be set to {Width}x{Height}; the pipeline is unchanged.",
                    target.Width,
                    target.Height);
            }

            return;
        }

        lock (_running)
        {
            _pending = (null, target.Width, target.Height);
        }
    }

    /// <summary>
    /// Capture a different display, without tearing the stream down.
    ///
    /// The alternative — stop and start again — costs a fresh negotiation, an ICE exchange,
    /// and several seconds of black screen, which is a lot to pay for looking at the other
    /// monitor. Switching in place costs a key frame and a re-layout, the same as any
    /// resolution change.
    ///
    /// The size is left at zero: the new display's own resolution decides it, fitted to
    /// whatever cap the profile set, and passing a size here would be guessing at a display
    /// this method has not looked at yet.
    /// </summary>
    public void RequestDisplay(IntPtr monitorHandle)
    {
        if (monitorHandle == _monitorHandle) return;

        lock (_running)
        {
            _pending = (monitorHandle, 0, 0);
        }
    }

    /// <summary>
    /// The largest encodable size within a cap, keeping the display's aspect ratio.
    ///
    /// Aspect ratio is preserved rather than stretched to the cap: a desktop squeezed into
    /// the wrong shape is worse than a smaller one, and the client renders what it is sent.
    /// </summary>
    public static (int Width, int Height) FitWithin(int width, int height, int maxWidth, int maxHeight)
    {
        if (width <= maxWidth && height <= maxHeight) return EvenSize(width, height);

        double scale = Math.Min(maxWidth / (double)width, maxHeight / (double)height);
        return EvenSize((int)Math.Round(width * scale), (int)Math.Round(height * scale));
    }

    /// <summary>
    /// Round to even dimensions, which NV12 requires.
    ///
    /// A 4:2:0 chroma plane is half the size of the luma plane in both directions, so an odd
    /// dimension has no representation. Encoders reject it, and the failure is reported as a
    /// generic media type error that says nothing about the cause.
    /// </summary>
    public static (int Width, int Height) EvenSize(int width, int height) =>
        (Math.Max(2, width & ~1), Math.Max(2, height & ~1));

    private void Run()
    {
        var frames = new List<EncodedVideoFrame>(4);
        TimeSpan presentation = TimeSpan.Zero;
        long nextTick = Stopwatch.GetTimestamp();

        while (!_stopping.IsCancellationRequested)
        {
            if (_capture.Closed)
            {
                // Unplugged, or switched off. The stream can carry on somewhere else, so
                // this is reported rather than quietly ending — a pipeline that just stopped
                // would leave the viewer on a frozen picture with nothing to explain it.
                _logger.LogInformation("The captured display went away.");
                DisplayLost?.Invoke();

                // Wait for a new display to be chosen rather than spinning on a dead capture.
                if (!WaitForNewDisplay()) return;
                continue;
            }

            ApplyPendingChange();
            RollWindow();

            // Re-read every iteration rather than hoisting: the interval is what adaptation
            // changes, and a loop that cached it would keep the old rate until it restarted.
            TimeSpan interval = TimeSpan.FromSeconds(1.0 / _targetFrameRate);

            long now = Stopwatch.GetTimestamp();
            if (now < nextTick)
            {
                // Sleep in small steps rather than spinning: at 60 fps the wait is ~16 ms,
                // and burning a core to be precise about it would defeat the purpose.
                var remaining = TimeSpan.FromSeconds((nextTick - now) / (double)Stopwatch.Frequency);
                Thread.Sleep(remaining > TimeSpan.FromMilliseconds(2) ? remaining - TimeSpan.FromMilliseconds(1) : TimeSpan.Zero);
                continue;
            }

            nextTick += (long)(interval.TotalSeconds * Stopwatch.Frequency);

            using CaptureFrameLease? lease = _capture.TryAcquire();
            if (lease is null)
            {
                // Nothing changed on screen since the last tick. That is normal on a static
                // desktop and is not a dropped frame.
                continue;
            }

            Interlocked.Increment(ref _framesCaptured);

            if (!_converter.Convert(lease.Frame.Texture))
            {
                continue;
            }

            long encodeStart = Stopwatch.GetTimestamp();
            frames.Clear();
            _encoder.Encode(_converter.Output, presentation, frames);
            double encodeMs = (Stopwatch.GetTimestamp() - encodeStart) * 1000.0 / Stopwatch.Frequency;

            presentation += interval;

            foreach (EncodedVideoFrame frame in frames)
            {
                Interlocked.Increment(ref _framesEncoded);
                Interlocked.Add(ref _bytesEncoded, frame.Data.Length);

                try
                {
                    _onFrame(frame);
                }
                catch (Exception ex)
                {
                    // A consumer that throws must not take the capture thread down with it.
                    _logger.LogError(ex, "The frame consumer threw; the stream continues.");
                }
            }

            lock (_running)
            {
                _encodeMsTotal += encodeMs;
                _windowEncodeMs += encodeMs;
                _windowEncodeCalls++;
            }
        }
    }

    /// <summary>
    /// Close the current measurement window if it has run long enough.
    ///
    /// Called from the capture loop rather than from <see cref="Stats"/> so that reading the
    /// statistics has no side effect. Two callers on different intervals — adaptation every
    /// second, the client's statistics every two — would otherwise keep cutting each other's
    /// windows short, and a test that read twice in quick succession would divide by very
    /// nearly nothing.
    ///
    /// The loop keeps turning when the screen is static and no frames arrive, so a stalled
    /// capture rolls the window too and correctly reports zero rather than the last healthy
    /// number for ever.
    /// </summary>
    private void RollWindow()
    {
        long now = Stopwatch.GetTimestamp();
        double elapsed = (now - _windowStartTicks) / (double)Stopwatch.Frequency;
        if (elapsed < WindowSeconds) return;

        long captured = Interlocked.Read(ref _framesCaptured);
        long encoded = Interlocked.Read(ref _framesEncoded);

        lock (_running)
        {
            _recentCapturedFps = (captured - _windowCaptured) / elapsed;
            _recentEncodedFps = (encoded - _windowEncoded) / elapsed;

            // Per encode call, not per captured frame: a frame the converter rejected cost
            // no encode time, and averaging it in would understate what encoding costs.
            _recentEncodeMs = _windowEncodeCalls == 0 ? 0 : _windowEncodeMs / _windowEncodeCalls;
            _windowMeasured = true;

            _windowEncodeMs = 0;
            _windowEncodeCalls = 0;
        }

        _windowCaptured = captured;
        _windowEncoded = encoded;
        _windowStartTicks = now;
    }

    /// <summary>
    /// Ask for a key frame, for a client that has just joined or lost sync.
    ///
    /// False means the encoder will not produce one on demand and the client has to wait
    /// for the next scheduled key frame.
    /// </summary>
    public bool RequestKeyFrame() => _encoder.RequestKeyFrame();

    /// <summary>Whether this encoder answers key frame requests at all.</summary>
    public bool SupportsForcedKeyFrames => _encoder.SupportsForcedKeyFrames;

    /// <summary>Change the target bitrate on the running encoder.</summary>
    public bool TrySetBitrate(int bitsPerSecond) => _encoder.TrySetBitrate(bitsPerSecond);

    /// <summary>
    /// Swap in a converter and encoder at a new size, between frames.
    ///
    /// The replacements are built before anything is torn down. If the GPU refuses the new
    /// size — an encoder has limits, and a driver may simply say no — the stream carries on
    /// at the size it was, which is far better than a stream that stops because it could not
    /// get smaller.
    /// </summary>
    /// <summary>
    /// Wait until somebody asks for a different display, or the pipeline stops.
    ///
    /// Returns false when the stream is ending. Spinning on a dead capture would burn a core
    /// for as long as the monitor stayed unplugged.
    /// </summary>
    private bool WaitForNewDisplay()
    {
        while (!_stopping.IsCancellationRequested)
        {
            lock (_running)
            {
                if (_pending?.Monitor is not null) return ApplyPendingChange();
            }

            _stopping.Token.WaitHandle.WaitOne(TimeSpan.FromMilliseconds(200));
        }

        return false;
    }

    private bool ApplyPendingChange()
    {
        (IntPtr? Monitor, int Width, int Height) target;
        lock (_running)
        {
            if (_pending is null) return false;
            target = _pending.Value;
            _pending = null;
        }

        try
        {
            return target.Monitor is { } monitor
                ? SwitchDisplay(monitor)
                : Resize(target.Width, target.Height);
        }
        catch (Exception ex)
        {
            // This thread runs unattended for the life of a stream. An exception escaping it
            // would end not just this stream but every other one in the process, so a change
            // that cannot be made leaves the pipeline exactly as it was.
            _logger.LogError(ex, "The requested change could not be applied; the stream is unchanged.");
            return false;
        }
    }

    /// <summary>
    /// Point the pipeline at another monitor.
    ///
    /// Everything is built before anything is torn down, so a display that cannot be
    /// captured — unplugged in the moment between choosing it and starting — leaves the
    /// stream exactly as it was rather than ending it.
    /// </summary>
    private bool SwitchDisplay(IntPtr monitorHandle)
    {
        DisplayCapture? capture = DisplayCapture.TryStart(
            _device,
            monitorHandle,
            _loggers.CreateLogger<DisplayCapture>());

        if (capture is null)
        {
            _logger.LogWarning("That display could not be captured; the stream stays where it was.");
            return false;
        }

        (int Width, int Height) encoded = _maxWidthPixels > 0 && _maxHeightPixels > 0
            ? FitWithin(capture.Width, capture.Height, _maxWidthPixels, _maxHeightPixels)
            : EvenSize(capture.Width, capture.Height);

        if (!RebuildEncodeChain(capture, encoded.Width, encoded.Height))
        {
            capture.Dispose();
            return false;
        }

        DisplayCapture old = _capture;
        _capture = capture;
        old.Dispose();

        _monitorHandle = monitorHandle;

        _logger.LogInformation(
            "Now capturing a {Width}x{Height} display, encoding at {EncodedWidth}x{EncodedHeight}.",
            capture.Width,
            capture.Height,
            encoded.Width,
            encoded.Height);

        return true;
    }

    private bool Resize(int width, int height)
    {
        if (width == _converter.Width && height == _converter.Height) return false;
        return RebuildEncodeChain(_capture, width, height);
    }

    /// <summary>
    /// Build a converter and encoder for one capture at one size, and swap them in.
    ///
    /// The replacements are constructed before anything is disposed. If the GPU refuses the
    /// new size — an encoder has limits, and a driver may simply say no — the stream carries
    /// on unchanged, which is far better than one that stops because it could not adjust.
    /// </summary>
    private bool RebuildEncodeChain(DisplayCapture capture, int width, int height)
    {
        ColorConverter? converter = ColorConverter.TryCreate(
            _device,
            capture.Width,
            capture.Height,
            width,
            height,
            _targetFrameRate,
            _loggers.CreateLogger<ColorConverter>());

        (int Width, int Height) target = (width, height);

        if (converter is null)
        {
            _logger.LogWarning(
                "The GPU refused to scale to {Width}x{Height}; the stream stays at {Current}x{CurrentHeight}.",
                target.Width,
                target.Height,
                _converter.Width,
                _converter.Height);
            return false;
        }

        H264Encoder? encoder = H264Encoder.TryCreate(
            _device,
            new EncoderSettings(target.Width, target.Height, _targetFrameRate, _bitrateBitsPerSecond),
            _loggers.CreateLogger<H264Encoder>());

        if (encoder is null)
        {
            converter.Dispose();
            _logger.LogWarning(
                "No encoder could be built at {Width}x{Height}; the stream stays at its current size.",
                target.Width,
                target.Height);
            return false;
        }

        ColorConverter oldConverter = _converter;
        H264Encoder oldEncoder = _encoder;

        _converter = converter;
        _encoder = encoder;

        oldEncoder.Dispose();
        oldConverter.Dispose();

        _logger.LogInformation(
            "Encoding resolution is now {Width}x{Height} from a {SourceWidth}x{SourceHeight} display.",
            target.Width,
            target.Height,
            capture.Width,
            capture.Height);

        return true;
    }

    public PipelineStats Stats()
    {
        double seconds = Math.Max(_running.Elapsed.TotalSeconds, 0.001);
        long captured = Interlocked.Read(ref _framesCaptured);
        long encoded = Interlocked.Read(ref _framesEncoded);

        double capturedFps;
        double encodedFps;
        double meanEncodeMs;

        lock (_running)
        {
            if (_windowMeasured)
            {
                capturedFps = _recentCapturedFps;
                encodedFps = _recentEncodedFps;
                meanEncodeMs = _recentEncodeMs;
            }
            else
            {
                // Before the first window closes there is nothing recent to report, so the
                // answer is what has happened so far. It is only ever the first second.
                capturedFps = captured / seconds;
                encodedFps = encoded / seconds;
                meanEncodeMs = captured == 0 ? 0 : _encodeMsTotal / captured;
            }
        }

        return new PipelineStats(
            CapturedFps: capturedFps,
            EncodedFps: encodedFps,
            FramesCaptured: captured,
            FramesEncoded: encoded,
            FramesDropped: _encoder.FramesDropped,
            BytesEncoded: Interlocked.Read(ref _bytesEncoded),
            MeanEncodeMs: meanEncodeMs,
            WidthPixels: EncodedWidth,
            HeightPixels: EncodedHeight,
            Encoder: _encoder.EncoderName,
            HardwareEncoded: _encoder.IsHardware);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        _stopping.Cancel();
        _thread?.Join(TimeSpan.FromSeconds(2));
        _thread = null;

        _encoder.Dispose();
        _converter.Dispose();
        _capture.Dispose();
        _stopping.Dispose();
        _running.Stop();
        _ = _device;

        // A shutdown summary is the one place a lifetime average is the right answer, so it
        // is computed here rather than read from Stats(), which reports the last second.
        PipelineStats stats = Stats();
        double lifetimeSeconds = Math.Max(_running.Elapsed.TotalSeconds, 0.001);

        _logger.LogInformation(
            "Capture pipeline stopped after {Frames} frames ({Fps:F1} fps, {Mb:F1} MB, {Ms:F1} ms/frame encode) over {Seconds:F1}s.",
            stats.FramesEncoded,
            stats.FramesEncoded / lifetimeSeconds,
            stats.BytesEncoded / 1_048_576.0,
            stats.FramesCaptured == 0 ? 0 : _encodeMsTotal / stats.FramesCaptured,
            lifetimeSeconds);
    }
}
