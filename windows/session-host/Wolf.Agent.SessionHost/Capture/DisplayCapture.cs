using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Microsoft.Extensions.Logging;
using Vortice.Direct3D11;
using Windows.Graphics;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;

namespace Wolf.Agent.SessionHost.Capture;

/// <summary>One captured frame. The texture is owned by the capture, not the caller.</summary>
public sealed record CapturedFrame(
    ID3D11Texture2D Texture,
    int Width,
    int Height,
    TimeSpan SystemRelativeTime);

/// <summary>
/// Captures one display through Windows Graphics Capture.
///
/// The frame pool is created free-threaded so the host does not need a message pump or a
/// dispatcher queue — it is a background process with no UI, and requiring one would mean
/// running a window just to pump messages.
///
/// Frames are pulled rather than pushed. A push model delivers at whatever rate the compositor
/// redraws, which on a 165 Hz display is far more often than any stream needs; pulling lets the
/// pipeline set its own pace and drop the frames in between without ever allocating them.
/// </summary>
[SupportedOSPlatform("windows10.0.19041.0")]
public sealed class DisplayCapture : IDisposable
{
    /// <summary>
    /// Two buffers is enough for a pull model and keeps latency down: more buffers only
    /// add frames that would be stale by the time they were read.
    /// </summary>
    private const int BufferCount = 2;

    private readonly CaptureDevice _device;
    private readonly ILogger<DisplayCapture> _logger;
    private readonly GraphicsCaptureItem _item;
    private readonly object _gate = new();

    private Direct3D11CaptureFramePool? _framePool;
    private GraphicsCaptureSession? _session;
    private SizeInt32 _size;
    private bool _disposed;

    private DisplayCapture(
        CaptureDevice device,
        GraphicsCaptureItem item,
        ILogger<DisplayCapture> logger)
    {
        _device = device;
        _item = item;
        _logger = logger;
        _size = item.Size;
    }

    public int Width => _size.Width;

    public int Height => _size.Height;

    /// <summary>True when Windows draws its capture border around the display being shared.</summary>
    public bool BorderShown { get; private set; } = true;

    /// <summary>
    /// Start capturing a monitor.
    ///
    /// Returns null when the monitor cannot be captured — it was unplugged, or this build
    /// of Windows does not support Graphics Capture. Both are reported rather than thrown,
    /// because both are ordinary conditions rather than programming errors.
    /// </summary>
    public static DisplayCapture? TryStart(
        CaptureDevice device,
        IntPtr monitorHandle,
        ILogger<DisplayCapture> logger)
    {
        if (!CaptureDevice.IsCaptureSupported())
        {
            logger.LogWarning("Windows Graphics Capture is not available on this build of Windows.");
            return null;
        }

        GraphicsCaptureItem? item = CaptureInterop.CreateItemForMonitor(monitorHandle);
        if (item is null)
        {
            logger.LogWarning("Could not create a capture item for the display; it may have been removed.");
            return null;
        }

        var capture = new DisplayCapture(device, item, logger);
        try
        {
            capture.Start();
            return capture;
        }
        catch (Exception ex) when (ex is COMException or InvalidOperationException or ArgumentException)
        {
            logger.LogError(ex, "Could not start capturing the display.");
            capture.Dispose();
            return null;
        }
    }

    private void Start()
    {
        _framePool = Direct3D11CaptureFramePool.CreateFreeThreaded(
            _device.WinRtDevice,
            DirectXPixelFormat.B8G8R8A8UIntNormalized,
            BufferCount,
            _size);

        _session = _framePool.CreateCaptureSession(_item);

        // The cursor is part of what an operator expects to see, so it stays on.
        TrySet(() => _session.IsCursorCaptureEnabled = true, "cursor capture");

        // Windows draws a coloured border around a captured display. Suppressing it is only
        // possible on Windows 11, and only for callers the OS grants it to, so WOLF asks and
        // records what it actually got — the person at the PC deserves to know they are
        // being watched, and the operator deserves to know whether that indicator is showing.
        BorderShown = !OperatingSystem.IsWindowsVersionAtLeast(10, 0, 22000) ||
                      !TrySet(() => _session.IsBorderRequired = false, "border suppression");

        _item.Closed += OnItemClosed;
        _session.StartCapture();

        _logger.LogInformation(
            "Capturing {Width}x{Height}; capture border {Border}.",
            _size.Width,
            _size.Height,
            BorderShown ? "shown" : "suppressed");
    }

    /// <summary>Apply an optional capture setting, reporting rather than failing if refused.</summary>
    private bool TrySet(Action action, string what)
    {
        try
        {
            action();
            return true;
        }
        catch (Exception ex) when (ex is COMException or UnauthorizedAccessException or NotSupportedException)
        {
            _logger.LogDebug("Windows refused {Setting}: {Message}", what, ex.Message);
            return false;
        }
    }

    private void OnItemClosed(GraphicsCaptureItem sender, object args)
    {
        _logger.LogInformation("The captured display was closed or removed.");
        Closed = true;
    }

    /// <summary>True once the display went away. The pipeline stops rather than spinning.</summary>
    public bool Closed { get; private set; }

    /// <summary>
    /// Take the most recent frame, or null when none has arrived since the last call.
    ///
    /// The caller must dispose the returned frame's owner promptly — see <see cref="Release"/> —
    /// because the frame pool has only two buffers and holding one starves the capture.
    /// </summary>
    public CaptureFrameLease? TryAcquire()
    {
        lock (_gate)
        {
            if (_disposed || Closed || _framePool is null) return null;

            Direct3D11CaptureFrame? frame;
            try
            {
                frame = _framePool.TryGetNextFrame();
            }
            catch (COMException ex)
            {
                _logger.LogWarning(ex, "The capture frame pool failed; capture will restart.");
                Closed = true;
                return null;
            }

            if (frame is null) return null;

            // The display resolution changed. Recreate the pool at the new size rather than
            // scaling: the encoder is configured for a fixed size, and a silent mismatch
            // would produce a stretched image nobody asked for.
            if (frame.ContentSize.Width != _size.Width || frame.ContentSize.Height != _size.Height)
            {
                _logger.LogInformation(
                    "The display resolution changed to {Width}x{Height}; recreating the capture.",
                    frame.ContentSize.Width,
                    frame.ContentSize.Height);

                _size = frame.ContentSize;
                frame.Dispose();
                Recreate();
                return null;
            }

            ID3D11Texture2D texture = CaptureInterop.GetTexture(frame.Surface);
            return new CaptureFrameLease(
                new CapturedFrame(texture, _size.Width, _size.Height, frame.SystemRelativeTime),
                frame,
                texture);
        }
    }

    private void Recreate()
    {
        try
        {
            _framePool?.Recreate(
                _device.WinRtDevice,
                DirectXPixelFormat.B8G8R8A8UIntNormalized,
                BufferCount,
                _size);
        }
        catch (COMException ex)
        {
            _logger.LogError(ex, "Could not recreate the capture frame pool after a resolution change.");
            Closed = true;
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed) return;
            _disposed = true;

            _item.Closed -= OnItemClosed;
            _session?.Dispose();
            _framePool?.Dispose();
            _session = null;
            _framePool = null;
        }

        _logger.LogDebug("Display capture stopped.");
    }
}

/// <summary>
/// A frame held from the pool.
///
/// Disposing returns the buffer. The pool has two, so a leaked lease stops capture within
/// two frames — which is why this is a distinct type rather than a convention.
/// </summary>
[SupportedOSPlatform("windows10.0.19041.0")]
public sealed class CaptureFrameLease : IDisposable
{
    private readonly Direct3D11CaptureFrame _frame;
    private readonly ID3D11Texture2D _texture;

    internal CaptureFrameLease(CapturedFrame frame, Direct3D11CaptureFrame source, ID3D11Texture2D texture)
    {
        Frame = frame;
        _frame = source;
        _texture = texture;
    }

    public CapturedFrame Frame { get; }

    public void Dispose()
    {
        _texture.Dispose();
        _frame.Dispose();
    }
}
