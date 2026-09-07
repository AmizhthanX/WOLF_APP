using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Vortice.Direct3D11;
using Vortice.DXGI;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX.Direct3D11;
using WinRT;

namespace Wolf.Agent.SessionHost.Capture;

/// <summary>
/// The three interop shims Windows Graphics Capture needs and the WinRT projection does
/// not provide.
///
/// Everything else about capture is available through the projected WinRT API. These are
/// the seams where the managed surface has to reach the underlying COM objects: creating a
/// capture item for a specific monitor, converting a D3D11 device into the WinRT device the
/// frame pool wants, and getting the actual texture back out of a captured frame.
///
/// They are small and stable, and each is documented by Microsoft, so hand-writing them is
/// far less risk than pulling in a wrapper for three calls.
/// </summary>
[SupportedOSPlatform("windows10.0.19041.0")]
internal static class CaptureInterop
{
    /// <summary>
    /// Creates a capture item for a window or a monitor.
    ///
    /// The picker-based API needs a window and a user gesture; this one does not, which is
    /// what lets a background session host capture a display without a UI.
    /// </summary>
    [ComImport]
    [Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IGraphicsCaptureItemInterop
    {
        IntPtr CreateForWindow([In] IntPtr window, [In] ref Guid iid);

        IntPtr CreateForMonitor([In] IntPtr monitor, [In] ref Guid iid);
    }

    /// <summary>Gets the underlying DXGI/D3D object out of a WinRT surface.</summary>
    [ComImport]
    [Guid("A9B3D012-3DF2-4EE3-B8D1-8695F457D3C1")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IDirect3DDxgiInterfaceAccess
    {
        IntPtr GetInterface([In] ref Guid iid);
    }

    [DllImport("d3d11.dll", EntryPoint = "CreateDirect3D11DeviceFromDXGIDevice", SetLastError = true)]
    private static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgiDevice, out IntPtr graphicsDevice);

    /// <summary>Wrap a D3D11 device as the WinRT device the capture frame pool requires.</summary>
    public static IDirect3DDevice CreateWinRtDevice(ID3D11Device device)
    {
        using IDXGIDevice dxgiDevice = device.QueryInterface<IDXGIDevice>();

        int result = CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice.NativePointer, out IntPtr inspectable);
        if (result < 0)
        {
            Marshal.ThrowExceptionForHR(result);
        }

        try
        {
            return MarshalInterface<IDirect3DDevice>.FromAbi(inspectable);
        }
        finally
        {
            Marshal.Release(inspectable);
        }
    }

    /// <summary>
    /// Create a capture item for one monitor.
    ///
    /// Returns null when the monitor has gone away between enumeration and capture, which
    /// happens routinely when a display is unplugged or a laptop is undocked.
    /// </summary>
    public static GraphicsCaptureItem? CreateItemForMonitor(IntPtr monitor)
    {
        // The interop interface lives on the runtime class's *activation factory*, not on an
        // instance — there is no instance yet, which is the whole point of this call.
        using IObjectReference factory = ActivationFactory.Get("Windows.Graphics.Capture.GraphicsCaptureItem");

        // Deliberately classic COM interop rather than the projection's own casting helper:
        // these are plain `IUnknown`-derived interfaces declared with `ComImport`, and
        // routing them through `GetObjectForIUnknown` gets a real `QueryInterface` and a
        // runtime-built vtable stub. The projection's cast path is for WinRT interfaces and
        // does not produce a usable proxy for these.
        object rcw = Marshal.GetObjectForIUnknown(factory.ThisPtr);
        try
        {
            var interop = (IGraphicsCaptureItemInterop)rcw;
            Guid iid = GraphicsCaptureItemIid;

            IntPtr abi = interop.CreateForMonitor(monitor, ref iid);
            if (abi == IntPtr.Zero) return null;

            try
            {
                return MarshalInterface<GraphicsCaptureItem>.FromAbi(abi);
            }
            finally
            {
                Marshal.Release(abi);
            }
        }
        catch (Exception ex) when (ex is COMException or InvalidCastException or ArgumentException)
        {
            return null;
        }
        finally
        {
            Marshal.ReleaseComObject(rcw);
        }
    }

    /// <summary>
    /// Get the Direct3D texture backing a captured frame.
    ///
    /// The texture belongs to the frame pool and is only valid until the frame is disposed,
    /// so callers must finish with it — or copy it — before releasing the frame.
    /// </summary>
    public static ID3D11Texture2D GetTexture(IDirect3DSurface surface)
    {
        IntPtr unknown = ((IWinRTObject)surface).NativeObject.ThisPtr;
        object rcw = Marshal.GetObjectForIUnknown(unknown);
        try
        {
            var access = (IDirect3DDxgiInterfaceAccess)rcw;
            Guid iid = Texture2DIid;

            IntPtr texture = access.GetInterface(ref iid);
            return new ID3D11Texture2D(texture);
        }
        finally
        {
            Marshal.ReleaseComObject(rcw);
        }
    }

    /// <summary>
    /// Interface ids written out rather than read from the projections.
    ///
    /// `typeof(GraphicsCaptureItem).GUID` returns the *runtime class* id, not the id of the
    /// interface the interop call expects, and the two are not the same value.
    /// </summary>
    private static readonly Guid GraphicsCaptureItemIid = new("79C3F95B-31F7-4EC2-A464-632EF5D30760");

    private static readonly Guid Texture2DIid = new("6F15AAF2-D208-4E89-9AB4-489535D34F9C");
}
