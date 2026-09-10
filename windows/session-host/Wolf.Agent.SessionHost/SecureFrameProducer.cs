using System.Runtime.Versioning;
using Microsoft.Extensions.Logging;
using Wolf.Agent.Core.Ipc;
using Wolf.Agent.SessionHost.Capture;
using Wolf.Agent.SessionHost.Displays;
using Wolf.Agent.SessionHost.Encoding;

namespace Wolf.Agent.SessionHost;

/// <summary>
/// Captures the secure desktop and sends the encoded frames up the pipe.
///
/// The secure host does not speak WebRTC. It has no peer connection, no ICE, no data channel
/// and no session — it produces H.264 and hands it to the service, which passes it to the
/// host that already holds a connection to the operator's browser. That keeps the process
/// running on the lock screen's desktop as small as it can be: a capture, an encoder, and a
/// pipe.
///
/// It is also why the frames are re-encoded rather than forwarded from the user host: the
/// user host cannot see this desktop at all. Nothing is being transcoded; this is the only
/// encoder that ever sees these pixels.
///
/// **Never run.** Like everything else on this path, it needs a service-launched process on
/// `winsta0\Winlogon`. What that means for the code below is that the failure paths matter
/// more than usual, and each one says which stage did not work.
/// </summary>
[SupportedOSPlatform("windows10.0.19041.0")]
public sealed class SecureFrameProducer : IDisposable
{
    private readonly DisplayEnumerator _displays;
    private readonly Func<HostFrameMessage, CancellationToken, Task> _send;
    private readonly Func<HostErrorMessage, CancellationToken, Task> _report;
    private readonly ILoggerFactory _loggers;
    private readonly ILogger<SecureFrameProducer> _logger;
    private readonly object _gate = new();

    private CaptureDevice? _device;
    private CapturePipeline? _pipeline;
    private CancellationToken _cancellation;

    public SecureFrameProducer(
        DisplayEnumerator displays,
        Func<HostFrameMessage, CancellationToken, Task> send,
        Func<HostErrorMessage, CancellationToken, Task> report,
        ILoggerFactory loggers)
    {
        _displays = displays;
        _send = send;
        _report = report;
        _loggers = loggers;
        _logger = loggers.CreateLogger<SecureFrameProducer>();
    }

    /// <summary>True while frames are being produced.</summary>
    public bool Capturing
    {
        get
        {
            lock (_gate) return _pipeline is not null;
        }
    }

    /// <summary>
    /// Start capturing, or do nothing if already started.
    ///
    /// Every failure is reported to the service rather than thrown. The service is a
    /// supervisor, not a caller that can handle an exception — and the operator on the far
    /// end is owed the reason the lock screen did not appear.
    /// </summary>
    public async Task StartAsync(ServiceSecureCaptureMessage request, CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            if (_pipeline is not null) return;
        }

        _cancellation = cancellationToken;

        _device ??= CaptureDevice.TryCreate(_loggers.CreateLogger<CaptureDevice>());
        if (_device is null)
        {
            await FailAsync(
                "capture-unsupported",
                "No Direct3D device could be created on the secure desktop.",
                limitation: false,
                cancellationToken).ConfigureAwait(false);
            return;
        }

        IntPtr? monitor = DisplayEnumerator.FindPrimaryMonitorHandle();
        if (monitor is null)
        {
            await FailAsync(
                "no-display",
                "The secure desktop reports no display to capture.",
                limitation: true,
                cancellationToken).ConfigureAwait(false);
            return;
        }

        // Duplication, always. Graphics Capture has no item to create on this desktop, and
        // asking it to try would spend the fallback's error path on a certainty.
        CapturePipeline? pipeline = CapturePipeline.TryCreate(
            _device,
            monitor.Value,
            request.TargetFps,
            request.BitrateBps,
            OnEncodedFrame,
            _loggers,
            request.MaxWidthPixels,
            request.MaxHeightPixels,
            preferDuplication: true);

        if (pipeline is null)
        {
            await FailAsync(
                "capture-unsupported",
                "The secure desktop could not be duplicated. This is the stage that has never " +
                "been observed working, and the agent's log names what Windows said.",
                limitation: false,
                cancellationToken).ConfigureAwait(false);
            return;
        }

        lock (_gate) _pipeline = pipeline;

        pipeline.Start();

        // The client has no reference picture for this encoder, so the first frame has to be
        // a key frame or it sees nothing until the next scheduled one.
        pipeline.RequestKeyFrame();

        _logger.LogInformation(
            "Capturing the secure desktop at {Width}x{Height}, {Fps} fps.",
            pipeline.EncodedWidth,
            pipeline.EncodedHeight,
            request.TargetFps);
    }

    /// <summary>Stop capturing. Called when the desktop unlocks, and on shutdown.</summary>
    public void Stop()
    {
        CapturePipeline? pipeline;

        lock (_gate)
        {
            pipeline = _pipeline;
            _pipeline = null;
        }

        if (pipeline is null) return;

        pipeline.Dispose();
        _logger.LogInformation("Stopped capturing the secure desktop.");
    }

    private void OnEncodedFrame(EncodedVideoFrame frame)
    {
        CapturePipeline? pipeline;
        lock (_gate) pipeline = _pipeline;
        if (pipeline is null) return;

        // Fire and forget on the capture thread. Waiting on the pipe here would pace capture
        // to whatever the service is doing, and a slow reader would show up as a stuttering
        // lock screen rather than as the dropped frame it is.
        _ = SendAsync(new HostFrameMessage(
            Data: Convert.ToBase64String(frame.Data),
            KeyFrame: frame.IsKeyFrame,
            WidthPixels: pipeline.EncodedWidth,
            HeightPixels: pipeline.EncodedHeight,
            TimestampMs: frame.Timestamp.TotalMilliseconds));
    }

    private async Task SendAsync(HostFrameMessage message)
    {
        try
        {
            await _send(message, _cancellation).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException or OperationCanceledException)
        {
            // The service has gone, or is going. The supervisor notices the pipe closing;
            // nothing useful happens by logging one line per frame about it.
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "A secure-desktop frame could not be sent.");
        }
    }

    private async Task FailAsync(string code, string message, bool limitation, CancellationToken cancellationToken)
    {
        _logger.LogWarning("Secure-desktop capture failed: {Code} {Message}", code, message);

        try
        {
            await _report(new HostErrorMessage(null, code, message, limitation), cancellationToken)
                .ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException or OperationCanceledException)
        {
        }
    }

    public void Dispose()
    {
        Stop();
        _device?.Dispose();
        _device = null;
    }
}
