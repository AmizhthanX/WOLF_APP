using System.Diagnostics;
using System.Runtime.Versioning;
using Microsoft.Extensions.Logging;
using SharpGen.Runtime;
using Vortice.Direct3D11;
using Vortice.DXGI;

namespace Wolf.Agent.SessionHost.Capture;

/// <summary>
/// Captures one display through DXGI Desktop Duplication.
///
/// The fallback for machines Windows Graphics Capture is not available on: it needs Windows
/// 10 1903, and Desktop Duplication goes back to Windows 8. Without this, those PCs report
/// that they cannot stream at all, which is a worse answer than a stream with one thing
/// missing from it.
///
/// The one thing missing is the mouse pointer. Duplication hands back the desktop image
/// without it and offers the pointer separately, as a shape to composite — three different
/// bitmap formats, blended per frame. That is not done here, so on this path the operator
/// sees the desktop move but not the cursor, and <see cref="CursorCaptured"/> says so rather
/// than leaving them to notice.
///
/// The other difference is the contract around frames. Graphics Capture pools buffers and
/// lets several be outstanding; duplication allows exactly one, and refuses to produce the
/// next until it is released. The pipeline converts and releases within a frame, so this
/// suits it — but it does mean a held lease stops capture immediately rather than in two
/// frames' time.
/// </summary>
[SupportedOSPlatform("windows10.0.19041.0")]
public sealed class DuplicationCapture : IDisplayCapture
{
    /// <summary>How this capture is named in the protocol and in the host's status.</summary>
    public const string ApiName = "desktop-duplication";

    /// <summary>
    /// How long to wait for a new frame before reporting there is none.
    ///
    /// Zero rather than a wait: the pipeline paces itself and calls again when it is ready,
    /// so blocking here would just move the wait somewhere it cannot be interrupted.
    /// </summary>
    private const int AcquireTimeoutMs = 0;

    /// <summary>
    /// Consecutive access-lost failures tolerated before the display is given up on.
    ///
    /// Access is lost for ordinary reasons — a mode change, the secure desktop appearing, a
    /// full-screen application taking over — and the fix is to duplicate the output again.
    /// A run of them that never recovers is a display that has genuinely gone.
    /// </summary>
    private const int MaxConsecutiveLosses = 20;

    private readonly CaptureDevice _device;
    private readonly IntPtr _monitorHandle;
    private readonly ILogger<DuplicationCapture> _logger;
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private readonly object _gate = new();

    private IDXGIOutput1? _output;
    private IDXGIOutputDuplication? _duplication;
    private int _width;
    private int _height;
    private int _losses;
    private bool _frameHeld;
    private bool _disposed;

    private DuplicationCapture(
        CaptureDevice device,
        IntPtr monitorHandle,
        ILogger<DuplicationCapture> logger)
    {
        _device = device;
        _monitorHandle = monitorHandle;
        _logger = logger;
    }

    public int Width => _width;

    public int Height => _height;

    public bool Closed { get; private set; }

    /// <summary>
    /// Duplication draws no border.
    ///
    /// Not a feature. Graphics Capture shows the person at the PC that their screen is being
    /// watched, and on this path Windows provides nothing equivalent — reported as false so
    /// the operator is not told an indicator is showing when it is not.
    /// </summary>
    public bool BorderShown => false;

    /// <summary>False: the desktop image arrives without the pointer composited into it.</summary>
    public bool CursorCaptured => false;

    public string Api => ApiName;

    /// <summary>
    /// Start duplicating a monitor, or return null with the reason logged.
    ///
    /// Null covers the ordinary cases as well as the broken ones: the monitor was unplugged,
    /// or another process already holds the one duplication Windows allows per output.
    /// </summary>
    public static DuplicationCapture? TryStart(
        CaptureDevice device,
        IntPtr monitorHandle,
        ILogger<DuplicationCapture> logger)
    {
        var capture = new DuplicationCapture(device, monitorHandle, logger);

        if (!capture.Open())
        {
            capture.Dispose();
            return null;
        }

        logger.LogInformation(
            "Duplicating {Width}x{Height} through Desktop Duplication; the pointer is not captured on this path.",
            capture.Width,
            capture.Height);

        return capture;
    }

    /// <summary>Find the output for this monitor and start duplicating it.</summary>
    private bool Open()
    {
        IDXGIOutput1? output = FindOutput(_monitorHandle, _logger);
        if (output is null) return false;

        try
        {
            _duplication = output.DuplicateOutput(_device.Device);
            _output = output;

            OutduplDescription description = _duplication.Description;
            _width = (int)description.ModeDescription.Width;
            _height = (int)description.ModeDescription.Height;

            return _width > 0 && _height > 0;
        }
        catch (SharpGenException ex)
        {
            // DXGI_ERROR_NOT_CURRENTLY_AVAILABLE means the machine has run out of the
            // duplications it allows, or something else already holds this output's one.
            _logger.LogWarning(ex, "Could not duplicate this display's output.");
            output.Dispose();
            return false;
        }
    }

    /// <summary>
    /// The DXGI output that drives a given monitor.
    ///
    /// Matched on the monitor handle rather than on the device name or ordering: the handle
    /// is what the rest of the host identifies a display by, and adapter and output indices
    /// are not stable across a display being unplugged.
    /// </summary>
    private static IDXGIOutput1? FindOutput(IntPtr monitorHandle, ILogger logger)
    {
        IDXGIFactory1? factory = null;

        try
        {
            factory = DXGI.CreateDXGIFactory1<IDXGIFactory1>();

            for (uint index = 0; ; index++)
            {
                if (factory.EnumAdapters1(index, out IDXGIAdapter1? adapter).Failure || adapter is null)
                {
                    break;
                }

                using (adapter)
                {
                    for (uint outputIndex = 0; ; outputIndex++)
                    {
                        if (adapter.EnumOutputs(outputIndex, out IDXGIOutput? output).Failure || output is null)
                        {
                            break;
                        }

                        using (output)
                        {
                            if (output.Description.Monitor != monitorHandle) continue;

                            // IDXGIOutput1 is where DuplicateOutput lives. Every adapter that
                            // can run a desktop has it, so failing here is a real fault.
                            return output.QueryInterface<IDXGIOutput1>();
                        }
                    }
                }
            }

            logger.LogWarning("No DXGI output matches this display; it may have been removed.");
            return null;
        }
        catch (SharpGenException ex)
        {
            logger.LogError(ex, "Could not enumerate DXGI outputs.");
            return null;
        }
        finally
        {
            factory?.Dispose();
        }
    }

    /// <inheritdoc />
    public CaptureFrameLease? TryAcquire()
    {
        lock (_gate)
        {
            if (_disposed || Closed || _duplication is null) return null;

            // Duplication allows exactly one outstanding frame. A lease that was dropped
            // without being disposed would otherwise wedge capture permanently, so the
            // previous one is released here rather than trusted to have been.
            ReleaseHeldFrame();

            Result result = _duplication.AcquireNextFrame(
                AcquireTimeoutMs,
                out OutduplFrameInfo info,
                out IDXGIResource? resource);

            if (result == Vortice.DXGI.ResultCode.WaitTimeout)
            {
                // Nothing changed on screen since the last call. Normal on a static desktop
                // and not a dropped frame.
                return null;
            }

            if (result.Failure)
            {
                resource?.Dispose();
                OnAcquireFailed(result);
                return null;
            }

            _losses = 0;

            if (resource is null) return null;

            // LastPresentTime is zero when only the pointer moved. There is no new desktop
            // image behind that, and encoding the same picture again would spend bitrate to
            // send nothing — on this path the pointer is not in the image anyway.
            if (info.LastPresentTime == 0)
            {
                resource.Dispose();
                _duplication.ReleaseFrame();
                return null;
            }

            ID3D11Texture2D texture;
            try
            {
                texture = resource.QueryInterface<ID3D11Texture2D>();
            }
            catch (SharpGenException ex)
            {
                _logger.LogWarning(ex, "A duplicated frame was not a Direct3D texture; skipping it.");
                resource.Dispose();
                _duplication.ReleaseFrame();
                return null;
            }
            finally
            {
                resource.Dispose();
            }

            _frameHeld = true;

            // Timestamps come from this capture's own clock. QPC values from the duplication
            // are on a different base to the frame pool's SystemRelativeTime, and the encoder
            // only needs them to advance evenly.
            return new CaptureFrameLease(
                new CapturedFrame(texture, _width, _height, _clock.Elapsed),
                texture,
                new FrameRelease(this));
        }
    }

    /// <summary>
    /// Decide what a failed acquire means.
    ///
    /// Access lost is the common one and is recoverable: a mode change, a full-screen
    /// application taking over, the secure desktop appearing. The answer is to duplicate the
    /// output again, which also picks up a new resolution.
    /// </summary>
    private void OnAcquireFailed(Result result)
    {
        if (result != Vortice.DXGI.ResultCode.AccessLost)
        {
            _logger.LogWarning("Desktop duplication failed ({Code}); the display is given up.", result);
            Closed = true;
            return;
        }

        _losses++;

        if (_losses > MaxConsecutiveLosses)
        {
            _logger.LogWarning(
                "Desktop duplication lost access {Count} times running; the display is given up.",
                _losses);
            Closed = true;
            return;
        }

        _logger.LogDebug("Desktop duplication lost access; duplicating the output again.");

        int previousWidth = _width;
        int previousHeight = _height;

        CloseDuplication();

        if (!Open())
        {
            // Not fatal on its own. The next call tries again, up to the run limit above,
            // because access is also lost while the secure desktop is up — which ends.
            return;
        }

        if (_width != previousWidth || _height != previousHeight)
        {
            _logger.LogInformation(
                "The display resolution changed to {Width}x{Height}.",
                _width,
                _height);
        }
    }

    private void ReleaseHeldFrame()
    {
        if (!_frameHeld) return;
        _frameHeld = false;

        try
        {
            _duplication?.ReleaseFrame();
        }
        catch (SharpGenException ex)
        {
            _logger.LogDebug("Releasing a duplicated frame failed: {Message}", ex.Message);
        }
    }

    private void CloseDuplication()
    {
        ReleaseHeldFrame();

        _duplication?.Dispose();
        _duplication = null;
        _output?.Dispose();
        _output = null;
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed) return;
            _disposed = true;
            CloseDuplication();
        }

        _logger.LogDebug("Desktop duplication stopped.");
    }

    /// <summary>
    /// Returns the one frame duplication lets be outstanding.
    ///
    /// Part of the lease rather than something the caller remembers to do, because until it
    /// happens no further frame can be acquired at all.
    /// </summary>
    private sealed class FrameRelease : IDisposable
    {
        private readonly DuplicationCapture _capture;

        public FrameRelease(DuplicationCapture capture) => _capture = capture;

        public void Dispose()
        {
            lock (_capture._gate)
            {
                _capture.ReleaseHeldFrame();
            }
        }
    }
}
