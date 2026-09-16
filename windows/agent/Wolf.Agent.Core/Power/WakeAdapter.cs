using System.Globalization;
using System.Management;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Wolf.Agent.Core.Power;

/// <summary>What this PC can say about being woken: its wired adapter's address, and whether Windows has armed it.</summary>
public sealed record WakeReport(string? MacAddress, bool Armed);

/// <summary>
/// This PC's wired adapter, as another PC would need to know it to wake this one.
///
/// Two facts, both readable without administrator:
///
/// - **The adapter**, from <c>MSFT_NetAdapter</c>: a hardware interface, not a virtual one, on 802.3 —
///   Ethernet. Hyper-V switches, VPN adapters and Bluetooth are left out by the first two; Wi-Fi by the
///   third, because almost no wireless adapter keeps listening while its PC sleeps.
/// - **Whether Windows has armed it to wake the PC**, from the same list <c>powercfg /devicequery
///   wake_armed</c> prints — asked of <c>powrprof.dll</c> directly, not by running powercfg.
///
/// What is <b>not</b> knowable from here: the firmware's own wake setting, and the adapter's
/// "wake on magic packet" property, which needs administrator to read. So an armed adapter is reported
/// as armed, never as "this PC will wake".
/// </summary>
[SupportedOSPlatform("windows")]
public static partial class WakeAdapter
{
    private const uint NdisPhysicalMedium8023 = 14;
    private static readonly TimeSpan CacheFor = TimeSpan.FromMinutes(10);
    private static readonly object Gate = new();
    private static (WakeReport Report, DateTimeOffset At)? _cached;

    /// <summary>Cached for ten minutes: capabilities are described on every reconnect, and neither fact changes often.</summary>
    public static WakeReport Current()
    {
        lock (Gate)
        {
            if (_cached is { } cached && DateTimeOffset.UtcNow - cached.At < CacheFor) return cached.Report;
            WakeReport report = Read();
            _cached = (report, DateTimeOffset.UtcNow);
            return report;
        }
    }

    /// <summary>Every hardware address this PC's adapters have, so it can refuse to broadcast a wake for itself.</summary>
    public static IReadOnlySet<string> OwnAddresses() =>
        System.Net.NetworkInformation.NetworkInterface.GetAllNetworkInterfaces()
            .Select(adapter => adapter.GetPhysicalAddress().GetAddressBytes())
            .Where(bytes => bytes.Length == 6)
            .Select(bytes => WakeOnLan.FormatMac(bytes))
            .ToHashSet(StringComparer.Ordinal);

    private static WakeReport Read()
    {
        IReadOnlySet<string> armed = WakeArmedDevices();
        var candidates = new List<(string Mac, bool Armed, bool Connected, uint Index)>();

        try
        {
            using var searcher = new ManagementObjectSearcher(
                @"root\StandardCimv2",
                "SELECT InterfaceDescription, PermanentAddress, HardwareInterface, Virtual, NdisPhysicalMedium, MediaConnectState, InterfaceIndex FROM MSFT_NetAdapter");
            using ManagementObjectCollection results = searcher.Get();

            foreach (ManagementBaseObject item in results)
            {
                using (item)
                {
                    if (item["HardwareInterface"] is not true || item["Virtual"] is true) continue;
                    if (Convert.ToUInt32(item["NdisPhysicalMedium"] ?? 0u, CultureInfo.InvariantCulture) != NdisPhysicalMedium8023) continue;

                    string? mac = FromPermanentAddress(item["PermanentAddress"] as string);
                    if (mac is null) continue;

                    string description = item["InterfaceDescription"] as string ?? string.Empty;
                    candidates.Add((
                        mac,
                        armed.Contains(description),
                        Convert.ToUInt32(item["MediaConnectState"] ?? 0u, CultureInfo.InvariantCulture) == 1,
                        Convert.ToUInt32(item["InterfaceIndex"] ?? 0u, CultureInfo.InvariantCulture)));
                }
            }
        }
        catch (Exception ex) when (ex is ManagementException or COMException or UnauthorizedAccessException)
        {
            return new WakeReport(null, false);
        }

        // An armed adapter first, then a connected one: that is the adapter the PC can actually be woken on.
        var chosen = candidates
            .OrderByDescending(c => c.Armed)
            .ThenByDescending(c => c.Connected)
            .ThenBy(c => c.Index)
            .FirstOrDefault();

        return chosen.Mac is null ? new WakeReport(null, false) : new WakeReport(chosen.Mac, chosen.Armed);
    }

    /// <summary>`D8BBC10A2B3C` → `d8:bb:c1:0a:2b:3c`, or null for anything that is not one adapter's address.</summary>
    public static string? FromPermanentAddress(string? permanent)
    {
        if (permanent is null) return null;
        string hex = permanent.Replace("-", string.Empty, StringComparison.Ordinal).Replace(":", string.Empty, StringComparison.Ordinal);
        if (hex.Length != 12) return null;

        string formatted = string.Join(':', Enumerable.Range(0, 6).Select(i => hex.Substring(i * 2, 2))).ToLowerInvariant();
        return WakeOnLan.TryParseMac(formatted, out _) ? formatted : null;
    }

    /// <summary>The friendly names of devices Windows has armed to wake the PC.</summary>
    private static IReadOnlySet<string> WakeArmedDevices()
    {
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        try
        {
            if (!DevicePowerOpen(0)) return names;
            try
            {
                var buffer = new byte[1024];
                for (uint index = 0; ; index++)
                {
                    uint size = (uint)buffer.Length;
                    if (!DevicePowerEnumDevices(index, DevicePowerFilterWakeEnabled | DevicePowerFilterDevicesPresent, 0, buffer, ref size)) break;
                    string name = System.Text.Encoding.Unicode.GetString(buffer, 0, (int)Math.Min(size, (uint)buffer.Length)).TrimEnd('\0');
                    int end = name.IndexOf('\0', StringComparison.Ordinal);
                    names.Add(end >= 0 ? name[..end] : name);
                }
            }
            finally
            {
                DevicePowerClose();
            }
        }
        catch (Exception ex) when (ex is DllNotFoundException or EntryPointNotFoundException)
        {
            // No answer is "not armed as far as WOLF can tell", which is what is reported.
        }

        return names;
    }

    // powrprof.h. The filters are ORed, not ANDed with a capability mask: that combination is the list
    // powercfg prints for wake_armed, checked against it on a real machine.
    private const uint DevicePowerFilterDevicesPresent = 0x20000000;
    private const uint DevicePowerFilterWakeEnabled = 0x08000000;

    [LibraryImport("powrprof.dll")]
    [return: MarshalAs(UnmanagedType.U1)]
    private static partial bool DevicePowerOpen(uint debugMask);

    [LibraryImport("powrprof.dll")]
    [return: MarshalAs(UnmanagedType.U1)]
    private static partial bool DevicePowerEnumDevices(uint queryIndex, uint queryInterpretationFlags, uint queryFlags, [Out] byte[] returnBuffer, ref uint bufferSize);

    [LibraryImport("powrprof.dll")]
    [return: MarshalAs(UnmanagedType.U1)]
    private static partial bool DevicePowerClose();
}
