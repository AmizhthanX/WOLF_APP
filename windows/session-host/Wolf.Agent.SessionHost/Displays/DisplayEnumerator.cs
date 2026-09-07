using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Microsoft.Extensions.Logging;
using Wolf.Agent.Core.Ipc;

namespace Wolf.Agent.SessionHost.Displays;

/// <summary>
/// Enumerates the monitors attached to this session.
///
/// This runs in the interactive session on purpose. The same enumeration from a service in
/// session 0 returns nothing, because session 0 has no desktop — which is exactly why the
/// session host exists.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed partial class DisplayEnumerator
{
    private readonly ILogger<DisplayEnumerator> _logger;

    public DisplayEnumerator(ILogger<DisplayEnumerator> logger)
    {
        _logger = logger;

        // Established here rather than only in Main because everything this class reports —
        // resolution, scale factor, monitor geometry — is wrong for a scaled display unless
        // the process is per-monitor aware, and a caller that constructed an enumerator has
        // already decided it wants the truth about displays.
        if (!DpiAwareness.EnsurePerMonitorAware())
        {
            _logger.LogWarning(
                "Could not declare per-monitor DPI awareness; display sizes may be reported in " +
                "scaled coordinates rather than real pixels.");
        }
    }

    public IReadOnlyList<IpcDisplay> Enumerate()
    {
        var displays = new List<IpcDisplay>();

        bool enumerated = EnumDisplayMonitors(
            IntPtr.Zero,
            IntPtr.Zero,
            (IntPtr monitor, IntPtr _, ref Rect _, IntPtr _) =>
            {
                IpcDisplay? display = Describe(monitor);
                if (display is not null) displays.Add(display);
                return true;
            },
            IntPtr.Zero);

        if (!enumerated)
        {
            _logger.LogWarning(
                "Could not enumerate displays (error {Error}).",
                Marshal.GetLastWin32Error());
        }

        return displays;
    }

    /// <summary>
    /// Find the monitor handle behind a display id.
    ///
    /// Re-enumerated on every call rather than cached: monitor handles do not survive a
    /// display being unplugged, a resolution change, or a session switch, and a stale one
    /// fails in a confusing place well after the fact.
    /// </summary>
    public IntPtr? FindMonitorHandle(string displayId)
    {
        IntPtr? found = null;

        EnumDisplayMonitors(
            IntPtr.Zero,
            IntPtr.Zero,
            (IntPtr monitor, IntPtr _, ref Rect _, IntPtr _) =>
            {
                var info = new MonitorInfoEx { cbSize = Marshal.SizeOf<MonitorInfoEx>() };
                if (GetMonitorInfo(monitor, ref info) &&
                    string.Equals(info.szDevice, displayId, StringComparison.OrdinalIgnoreCase))
                {
                    found = monitor;
                    return false; // Stop enumerating.
                }

                return true;
            },
            IntPtr.Zero);

        if (found is null)
        {
            _logger.LogWarning("No monitor matches display id {DisplayId}.", displayId);
        }

        return found;
    }

    /// <summary>The handle of the primary display, for a stream that named no display.</summary>
    public static IntPtr? FindPrimaryMonitorHandle()
    {
        IntPtr? found = null;

        EnumDisplayMonitors(
            IntPtr.Zero,
            IntPtr.Zero,
            (IntPtr monitor, IntPtr _, ref Rect _, IntPtr _) =>
            {
                var info = new MonitorInfoEx { cbSize = Marshal.SizeOf<MonitorInfoEx>() };
                if (GetMonitorInfo(monitor, ref info) && (info.dwFlags & MonitorPrimary) != 0)
                {
                    found = monitor;
                    return false;
                }

                return true;
            },
            IntPtr.Zero);

        return found;
    }

    private IpcDisplay? Describe(IntPtr monitor)
    {
        var info = new MonitorInfoEx { cbSize = Marshal.SizeOf<MonitorInfoEx>() };
        if (!GetMonitorInfo(monitor, ref info))
        {
            return null;
        }

        int width = info.rcMonitor.Right - info.rcMonitor.Left;
        int height = info.rcMonitor.Bottom - info.rcMonitor.Top;

        // The friendly name comes from the display device, not the monitor handle. When it
        // is unavailable the adapter name is a better answer than an invented one.
        string name = ReadFriendlyName(info.szDevice) ?? info.szDevice;

        return new IpcDisplay(
            Id: info.szDevice,
            Name: name,
            WidthPixels: width,
            HeightPixels: height,
            RefreshHz: ReadRefreshRate(info.szDevice),
            Primary: (info.dwFlags & MonitorPrimary) != 0,
            ScaleFactor: ReadScaleFactor(monitor),
            // HDR detection needs the DXGI output description; until the capture pipeline
            // opens the adapter, reporting false is the honest answer rather than a guess.
            Hdr: false,
            OriginX: info.rcMonitor.Left,
            OriginY: info.rcMonitor.Top);
    }

    private static string? ReadFriendlyName(string deviceName)
    {
        var device = new DisplayDevice { cb = Marshal.SizeOf<DisplayDevice>() };
        // Index 0 of an adapter is the monitor attached to it.
        return EnumDisplayDevices(deviceName, 0, ref device, 0) &&
               !string.IsNullOrWhiteSpace(device.DeviceString)
            ? device.DeviceString
            : null;
    }

    private static double? ReadRefreshRate(string deviceName)
    {
        var mode = new DevMode { dmSize = (short)Marshal.SizeOf<DevMode>() };
        if (!EnumDisplaySettings(deviceName, EnumCurrentSettings, ref mode))
        {
            return null;
        }

        return mode.dmDisplayFrequency > 1 ? mode.dmDisplayFrequency : null;
    }

    private double? ReadScaleFactor(IntPtr monitor)
    {
        // GetDpiForMonitor is per-monitor, which matters on mixed-DPI setups where a single
        // system-wide scale factor would be wrong for at least one screen.
        int result = GetDpiForMonitor(monitor, MonitorDpiType.Effective, out uint dpiX, out _);
        if (result != 0 || dpiX == 0)
        {
            _logger.LogDebug("Could not read the DPI for a monitor; scale is reported as unknown.");
            return null;
        }

        return Math.Round(dpiX / 96.0, 2);
    }

    // -------------------------------------------------------------------------
    // Interop
    // -------------------------------------------------------------------------

    private const int MonitorPrimary = 0x00000001;
    private const int EnumCurrentSettings = -1;

    private enum MonitorDpiType
    {
        Effective = 0,
        Angular = 1,
        Raw = 2,
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct MonitorInfoEx
    {
        public int cbSize;
        public Rect rcMonitor;
        public Rect rcWork;
        public int dwFlags;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string szDevice;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DisplayDevice
    {
        public int cb;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string DeviceName;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string DeviceString;

        public int StateFlags;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string DeviceID;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string DeviceKey;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DevMode
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string dmDeviceName;

        public short dmSpecVersion;
        public short dmDriverVersion;
        public short dmSize;
        public short dmDriverExtra;
        public int dmFields;
        public int dmPositionX;
        public int dmPositionY;
        public int dmDisplayOrientation;
        public int dmDisplayFixedOutput;
        public short dmColor;
        public short dmDuplex;
        public short dmYResolution;
        public short dmTTOption;
        public short dmCollate;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string dmFormName;

        public short dmLogPixels;
        public int dmBitsPerPel;
        public int dmPelsWidth;
        public int dmPelsHeight;
        public int dmDisplayFlags;
        public int dmDisplayFrequency;
        public int dmICMMethod;
        public int dmICMIntent;
        public int dmMediaType;
        public int dmDitherType;
        public int dmReserved1;
        public int dmReserved2;
        public int dmPanningWidth;
        public int dmPanningHeight;
    }

    private delegate bool MonitorEnumProc(IntPtr monitor, IntPtr dc, ref Rect rect, IntPtr data);

#pragma warning disable SYSLIB1054 // Callback and ByValTStr structs need runtime marshalling.
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumDisplayMonitors(
        IntPtr hdc,
        IntPtr lprcClip,
        MonitorEnumProc lpfnEnum,
        IntPtr dwData);

    [DllImport("user32.dll", EntryPoint = "GetMonitorInfoW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MonitorInfoEx lpmi);

    [DllImport("user32.dll", EntryPoint = "EnumDisplayDevicesW", CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumDisplayDevices(
        string? lpDevice,
        uint iDevNum,
        ref DisplayDevice lpDisplayDevice,
        uint dwFlags);

    [DllImport("user32.dll", EntryPoint = "EnumDisplaySettingsW", CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumDisplaySettings(string? lpszDeviceName, int iModeNum, ref DevMode lpDevMode);

    [DllImport("shcore.dll")]
    private static extern int GetDpiForMonitor(
        IntPtr hmonitor,
        MonitorDpiType dpiType,
        out uint dpiX,
        out uint dpiY);
#pragma warning restore SYSLIB1054
}
