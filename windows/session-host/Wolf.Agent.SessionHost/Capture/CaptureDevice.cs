using System.Runtime.Versioning;
using Microsoft.Extensions.Logging;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX.Direct3D11;

namespace Wolf.Agent.SessionHost.Capture;

/// <summary>
/// The Direct3D device the whole pipeline shares.
///
/// Capture, colour conversion, and the encoder all run on one device on purpose: a frame
/// captured onto the GPU can then be converted and encoded without ever crossing to system
/// memory. Using separate devices would force a copy per frame through the CPU, which at
/// 1080p60 is the difference between a few percent of a core and a visible tax on the
/// machine WOLF is supposed to stay out of the way of.
/// </summary>
[SupportedOSPlatform("windows10.0.19041.0")]
public sealed class CaptureDevice : IDisposable
{
    private readonly ILogger<CaptureDevice> _logger;

    private CaptureDevice(
        ID3D11Device device,
        ID3D11DeviceContext context,
        IDirect3DDevice winRtDevice,
        string adapterName,
        ILogger<CaptureDevice> logger)
    {
        Device = device;
        Context = context;
        WinRtDevice = winRtDevice;
        AdapterName = adapterName;
        _logger = logger;
    }

    public ID3D11Device Device { get; }

    public ID3D11DeviceContext Context { get; }

    /// <summary>The same device, in the form the capture frame pool requires.</summary>
    public IDirect3DDevice WinRtDevice { get; }

    public string AdapterName { get; }

    /// <summary>True when this build of Windows offers Graphics Capture at all. </summary>
    public static bool IsCaptureSupported()
    {
        try
        {
            return GraphicsCaptureSession.IsSupported();
        }
        catch (Exception ex) when (ex is TypeLoadException or DllNotFoundException or NotSupportedException)
        {
            // An older Windows build, or one without the capture APIs present.
            return false;
        }
    }

    /// <summary>
    /// Create the device, or return null with the reason logged.
    ///
    /// `BgraSupport` is required because capture hands back BGRA surfaces; `VideoSupport`
    /// is required because the colour conversion to NV12 runs on the video processor. A
    /// device created without either would fail later, in a much less obvious place.
    /// </summary>
    public static CaptureDevice? TryCreate(ILogger<CaptureDevice> logger)
    {
        DeviceCreationFlags flags = DeviceCreationFlags.BgraSupport | DeviceCreationFlags.VideoSupport;

        foreach (DriverType driver in new[] { DriverType.Hardware, DriverType.Warp })
        {
            try
            {
                Vortice.Direct3D11.D3D11.D3D11CreateDevice(
                    null,
                    driver,
                    flags,
                    new[] { FeatureLevel.Level_11_1, FeatureLevel.Level_11_0 },
                    out ID3D11Device? device,
                    out FeatureLevel level,
                    out ID3D11DeviceContext? context).CheckError();

                if (device is null || context is null)
                {
                    continue;
                }

                // Media Foundation shares this device with the encoder MFT on its own
                // threads. Without multithread protection the driver refuses the surfaces
                // with MF_E_UNSUPPORTED_D3D_TYPE — a misleading error for what is really a
                // threading contract, and one that only shows up at the first ProcessInput.
                EnableMultithreadProtection(context, logger);

                string adapter = ReadAdapterName(device);
                IDirect3DDevice winRtDevice = CaptureInterop.CreateWinRtDevice(device);

                if (driver == DriverType.Warp)
                {
                    // WARP is a software rasteriser. Capture works, but everything costs the
                    // CPU, so this is worth saying out loud rather than quietly tolerating.
                    logger.LogWarning(
                        "No hardware Direct3D device was available; falling back to the software renderer. " +
                        "Streaming will cost noticeably more CPU.");
                }
                else
                {
                    logger.LogInformation(
                        "Direct3D device created on {Adapter} at feature level {Level}.",
                        adapter,
                        level);
                }

                return new CaptureDevice(device, context, winRtDevice, adapter, logger);
            }
            catch (Exception ex) when (ex is SharpGen.Runtime.SharpGenException or InvalidOperationException)
            {
                logger.LogWarning(
                    "Could not create a Direct3D device with the {Driver} driver: {Message}",
                    driver,
                    ex.Message);
            }
        }

        logger.LogError("No Direct3D device could be created; this PC cannot capture its screen.");
        return null;
    }

    /// <summary>
    /// Let Direct3D serialise calls from the several threads that touch this device.
    ///
    /// Capture delivers frames on a pool thread, the encoder runs its own, and the pipeline
    /// drives conversion from a third. Without this the device is not safe to share, and
    /// Media Foundation refuses to use it at all.
    /// </summary>
    private static void EnableMultithreadProtection(ID3D11DeviceContext context, ILogger<CaptureDevice> logger)
    {
        try
        {
            using ID3D11Multithread multithread = context.QueryInterface<ID3D11Multithread>();
            multithread.SetMultithreadProtected(true);
        }
        catch (Exception ex) when (ex is SharpGen.Runtime.SharpGenException or InvalidOperationException)
        {
            logger.LogWarning(
                "Could not enable Direct3D multithread protection; hardware encoding may refuse this device.");
        }
    }

    private static string ReadAdapterName(ID3D11Device device)
    {
        try
        {
            using Vortice.DXGI.IDXGIDevice dxgi = device.QueryInterface<Vortice.DXGI.IDXGIDevice>();
            using Vortice.DXGI.IDXGIAdapter adapter = dxgi.GetAdapter();
            return adapter.Description.Description;
        }
        catch (Exception ex) when (ex is SharpGen.Runtime.SharpGenException or InvalidOperationException)
        {
            return "unknown adapter";
        }
    }

    public void Dispose()
    {
        try
        {
            WinRtDevice.Dispose();
        }
        catch (ObjectDisposedException)
        {
        }

        Context.Dispose();
        Device.Dispose();
        _logger.LogDebug("Direct3D device released.");
    }
}
