using System.Management;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Microsoft.Extensions.Logging;
using Wolf.Agent.Core.Privileged;

namespace Wolf.Agent.Helper;

/// <summary>
/// Lists hardware and turns it off or on.
///
/// Two very different halves. Listing comes from WMI, needs nothing special, and is the part
/// an operator will actually use most: what is attached, what is disabled, what has a driver
/// problem. Changing a device's state needs SetupAPI and administrative rights, and is the
/// most dangerous thing WOLF can do short of destroying data.
///
/// The safety rules live in <see cref="DeviceProtection"/> and are applied here before
/// Windows is asked for anything. They are checked in this process rather than only in the
/// cloud on purpose: the cloud classifies risk so an operator is asked to confirm, and the
/// helper refuses outright the things no confirmation should unlock. Those are different
/// jobs, and only one of them survives a compromised agent.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class DeviceManager
{
    private readonly ILogger<DeviceManager> _logger;

    public DeviceManager(ILogger<DeviceManager> logger)
    {
        _logger = logger;
    }

    /// <summary>Devices Windows knows about, with what WOLF will and will not do to each.</summary>
    public IReadOnlyList<HelperDevice> List(string? deviceClass, bool includeAbsent)
    {
        HashSet<string> connectedAdapters = ConnectedNetworkAdapterIds();
        var devices = new List<HelperDevice>();

        string where = includeAbsent ? string.Empty : " WHERE Present = TRUE";

        ManagementObjectCollection results;
        try
        {
            using var searcher = new ManagementObjectSearcher(
                "SELECT DeviceID, Name, PNPClass, Manufacturer, ConfigManagerErrorCode, Present, Status " +
                "FROM Win32_PnPEntity" + where);
            results = searcher.Get();
        }
        catch (ManagementException ex)
        {
            _logger.LogError(ex, "Could not enumerate devices.");
            return Array.Empty<HelperDevice>();
        }

        foreach (ManagementBaseObject item in results)
        {
            using (item)
            {
                string? instanceId = AsString(item["DeviceID"]);
                if (instanceId is null) continue;

                string? pnpClass = AsString(item["PNPClass"]);
                if (deviceClass is not null &&
                    !string.Equals(pnpClass, deviceClass, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                int? problemCode = AsInt(item["ConfigManagerErrorCode"]);
                bool present = item["Present"] is not bool flag || flag;

                bool networkConnected = connectedAdapters.Contains(Normalise(instanceId));

                devices.Add(new HelperDevice(
                    InstanceId: instanceId,
                    Name: AsString(item["Name"]) ?? instanceId,
                    DeviceClass: pnpClass,
                    Manufacturer: AsString(item["Manufacturer"]),
                    State: StateOf(problemCode),
                    ProblemCode: problemCode is 0 ? null : problemCode,
                    Problem: DescribeProblem(problemCode),
                    Present: present,
                    ProtectedBy: DeviceProtection.For(pnpClass, networkConnected)));
            }
        }

        return devices;
    }

    /// <summary>
    /// Turn a device off or on.
    ///
    /// Checks come in a deliberate order: the device has to exist, be the one the caller
    /// thought it was, and not be protected — before Windows is asked to do anything. The
    /// name check is the same idea as terminating a process by pid *and* expected name: an
    /// instance id is stable, but a dashboard can be minutes out of date, and disabling the
    /// wrong device is not something an operator gets to take back.
    /// </summary>
    public HelperDeviceResult SetEnabled(string instanceId, bool enabled, string expectedName)
    {
        HelperDevice? device = List(null, includeAbsent: true)
            .FirstOrDefault(candidate =>
                string.Equals(candidate.InstanceId, instanceId, StringComparison.OrdinalIgnoreCase));

        if (device is null)
        {
            return new HelperDeviceResult(
                instanceId,
                expectedName,
                Ok: false,
                State: "unknown",
                RestartRequired: false,
                Code: "device-not-found",
                Message: "No device on this PC has that instance id. It may have been removed.");
        }

        if (!NamesMatch(device.Name, expectedName))
        {
            _logger.LogWarning(
                "Refused a device change: {InstanceId} is now '{Actual}', not '{Expected}'.",
                instanceId,
                device.Name,
                expectedName);

            return new HelperDeviceResult(
                instanceId,
                device.Name,
                Ok: false,
                State: device.State,
                RestartRequired: false,
                Code: "device-changed",
                Message:
                    $"That instance id is now '{device.Name}', not '{expectedName}'. " +
                    "Refresh the device list and try again.");
        }

        // Only disabling is refused. Enabling a protected device gives function back, which
        // is the direction that fixes a mistake rather than making one.
        if (!enabled && device.ProtectedBy is { } protection)
        {
            _logger.LogWarning(
                "Refused to disable {Name}: {Protection}.",
                device.Name,
                protection);

            return DeviceProtection.Refuse(instanceId, device.Name, protection);
        }

        return Apply(device, enabled);
    }

    /// <summary>Ask Windows to change the device's state, and report what it says.</summary>
    private HelperDeviceResult Apply(HelperDevice device, bool enabled)
    {
        IntPtr devices = SetupDiCreateDeviceInfoList(IntPtr.Zero, IntPtr.Zero);
        if (devices == InvalidHandle)
        {
            return Failed(device, "Windows would not open the device list.");
        }

        try
        {
            var info = new SpDevinfoData { CbSize = (uint)Marshal.SizeOf<SpDevinfoData>() };

            if (!SetupDiOpenDeviceInfo(devices, device.InstanceId, IntPtr.Zero, 0, ref info))
            {
                return Failed(device, $"Windows could not open that device (error {Marshal.GetLastWin32Error()}).");
            }

            var change = new SpPropchangeParams
            {
                ClassInstallHeader = new SpClassinstallHeader
                {
                    CbSize = (uint)Marshal.SizeOf<SpClassinstallHeader>(),
                    InstallFunction = DifPropertyChange,
                },
                StateChange = enabled ? DicsEnable : DicsDisable,

                // Global rather than per-hardware-profile: WOLF is not managing docking
                // profiles, and a change that applied to only one of them would look like it
                // had not worked.
                Scope = DicsFlagGlobal,
                HwProfile = 0,
            };

            if (!SetupDiSetClassInstallParams(devices, ref info, ref change, (uint)Marshal.SizeOf<SpPropchangeParams>()))
            {
                return Failed(device, $"Windows refused the change (error {Marshal.GetLastWin32Error()}).");
            }

            if (!SetupDiCallClassInstaller(DifPropertyChange, devices, ref info))
            {
                int error = Marshal.GetLastWin32Error();

                return error == ErrorNotDisableable
                    ? new HelperDeviceResult(
                        device.InstanceId,
                        device.Name,
                        Ok: false,
                        State: device.State,
                        RestartRequired: false,
                        Code: "not-disableable",
                        Message: "Windows says this device cannot be disabled.")
                    : Failed(device, $"Windows refused the change (error {error}).");
            }

            // Whether the change actually took, read back rather than assumed. A device that
            // needs a restart reports its old state here, which is exactly the case that
            // would otherwise be reported as a silent success.
            HelperDevice? after = List(null, includeAbsent: true)
                .FirstOrDefault(candidate =>
                    string.Equals(candidate.InstanceId, device.InstanceId, StringComparison.OrdinalIgnoreCase));

            string state = after?.State ?? "unknown";
            bool applied = enabled ? state == "working" : state == "disabled";

            _logger.LogInformation(
                "{Action} {Name}; Windows now reports it as {State}.",
                enabled ? "Enabled" : "Disabled",
                device.Name,
                state);

            return new HelperDeviceResult(
                device.InstanceId,
                device.Name,
                Ok: true,
                State: state,
                RestartRequired: !applied,
                Code: null,
                Message: applied
                    ? null
                    : "Windows accepted the change but needs this PC restarted before it takes effect.");
        }
        finally
        {
            SetupDiDestroyDeviceInfoList(devices);
        }
    }

    private static HelperDeviceResult Failed(HelperDevice device, string message) =>
        new(
            device.InstanceId,
            device.Name,
            Ok: false,
            State: device.State,
            RestartRequired: false,
            Code: "windows-refused",
            Message: message);

    /// <summary>
    /// Whether the device is the one the caller meant.
    ///
    /// Compared loosely on purpose: Windows renames devices as drivers install, and a
    /// trailing "(COM3)" or a case change is not somebody pointing at different hardware.
    /// What this catches is the instance id having been reused by something else entirely.
    /// </summary>
    public static bool NamesMatch(string actual, string expected) =>
        string.Equals(actual.Trim(), expected.Trim(), StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Instance ids of network adapters that currently have a live connection.
    ///
    /// Used to decide whether a network device is protected. Only connected ones are: a
    /// disconnected adapter can be disabled and re-enabled safely, and refusing every
    /// network device would make the class useless for what it is most often wanted for.
    /// </summary>
    private static HashSet<string> ConnectedNetworkAdapterIds()
    {
        var connected = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        try
        {
            using var searcher = new ManagementObjectSearcher(
                "SELECT PNPDeviceID, NetEnabled, NetConnectionStatus FROM Win32_NetworkAdapter " +
                "WHERE PhysicalAdapter = TRUE");

            foreach (ManagementBaseObject item in searcher.Get())
            {
                using (item)
                {
                    string? pnpId = AsString(item["PNPDeviceID"]);
                    if (pnpId is null) continue;

                    // 2 is "Connected" in Win32_NetworkAdapter's own vocabulary.
                    if (AsInt(item["NetConnectionStatus"]) == 2) connected.Add(Normalise(pnpId));
                }
            }
        }
        catch (ManagementException)
        {
            // Cannot tell which adapters are live. The safe reading is that any of them
            // might be, so every network adapter is treated as connected.
            return AllNetworkAdapterIds();
        }

        return connected;
    }

    /// <summary>
    /// Every network adapter, for when Windows will not say which are connected.
    ///
    /// Failing towards protecting more devices rather than fewer. The cost is being unable to
    /// disable an idle adapter on a machine whose WMI is unhappy; the alternative cost is
    /// cutting the link WOLF is managing the PC over.
    /// </summary>
    private static HashSet<string> AllNetworkAdapterIds()
    {
        var all = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (NetworkInterface adapter in NetworkInterface.GetAllNetworkInterfaces())
        {
            all.Add(Normalise(adapter.Id));
        }

        return all;
    }

    /// <summary>
    /// Windows' Configuration Manager error code, translated into one word.
    ///
    /// 0 is a working device and 22 is one somebody turned off. Everything else is a device
    /// with a problem, which is deliberately not folded into "disabled": a driver fault and a
    /// switched-off device look identical in a two-state list and call for different
    /// responses.
    /// </summary>
    private static string StateOf(int? problemCode) => problemCode switch
    {
        null => "unknown",
        0 => "working",
        22 => "disabled",
        _ => "error",
    };

    /// <summary>
    /// What the problem code means, for the handful worth naming.
    ///
    /// Short on purpose. There are over fifty codes, most of them meaningless to anybody who
    /// is not debugging a driver, and inventing plain-English descriptions for codes nobody
    /// has seen produces confident text that may be wrong.
    /// </summary>
    private static string? DescribeProblem(int? problemCode) => problemCode switch
    {
        null or 0 => null,
        1 => "Not configured correctly.",
        10 => "Cannot start.",
        12 => "Not enough free resources.",
        18 => "Drivers need reinstalling.",
        19 => "The registry entry for this device is damaged.",
        22 => "Disabled.",
        28 => "No drivers are installed.",
        31 => "Windows cannot load the driver for this device.",
        43 => "Windows stopped this device because it reported problems.",
        45 => "Not connected to the PC.",
        _ => $"Windows reports problem code {problemCode}.",
    };

    /// <summary>Strip separators so a PNP id and an adapter id can be compared.</summary>
    private static string Normalise(string identifier) =>
        identifier.Replace("\\", string.Empty, StringComparison.Ordinal)
            .Replace("&", string.Empty, StringComparison.Ordinal)
            .Replace("{", string.Empty, StringComparison.Ordinal)
            .Replace("}", string.Empty, StringComparison.Ordinal)
            .ToUpperInvariant();

    private static string? AsString(object? value)
    {
        string? text = value?.ToString();
        return string.IsNullOrWhiteSpace(text) ? null : text;
    }

    private static int? AsInt(object? value) =>
        value is null ? null : int.TryParse(value.ToString(), out int parsed) ? parsed : null;

    // -----------------------------------------------------------------------
    // SetupAPI
    // -----------------------------------------------------------------------

    private static readonly IntPtr InvalidHandle = new(-1);

    private const uint DifPropertyChange = 0x00000012;
    private const uint DicsEnable = 0x00000001;
    private const uint DicsDisable = 0x00000002;
    private const uint DicsFlagGlobal = 0x00000001;
    private const int ErrorNotDisableable = unchecked((int)0xE0000231);

    [StructLayout(LayoutKind.Sequential)]
    private struct SpDevinfoData
    {
        public uint CbSize;
        public Guid ClassGuid;
        public uint DevInst;
        public IntPtr Reserved;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SpClassinstallHeader
    {
        public uint CbSize;
        public uint InstallFunction;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SpPropchangeParams
    {
        public SpClassinstallHeader ClassInstallHeader;
        public uint StateChange;
        public uint Scope;
        public uint HwProfile;
    }

    [DllImport("setupapi.dll", SetLastError = true)]
    private static extern IntPtr SetupDiCreateDeviceInfoList(IntPtr classGuid, IntPtr parent);

    [DllImport("setupapi.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetupDiDestroyDeviceInfoList(IntPtr devices);

    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, EntryPoint = "SetupDiOpenDeviceInfoW", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetupDiOpenDeviceInfo(
        IntPtr devices,
        string instanceId,
        IntPtr parent,
        uint flags,
        ref SpDevinfoData info);

    [DllImport("setupapi.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetupDiSetClassInstallParams(
        IntPtr devices,
        ref SpDevinfoData info,
        ref SpPropchangeParams parameters,
        uint size);

    [DllImport("setupapi.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetupDiCallClassInstaller(
        uint installFunction,
        IntPtr devices,
        ref SpDevinfoData info);
}
