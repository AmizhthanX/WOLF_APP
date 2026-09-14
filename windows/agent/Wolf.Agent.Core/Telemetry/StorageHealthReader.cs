using System.Management;
using System.Runtime.Versioning;

namespace Wolf.Agent.Core.Telemetry;

/// <summary>What Windows' storage stack says about the drive behind one volume.</summary>
/// <param name="HealthStatus">healthy, warning, failing or unknown — the telemetry schema's words.</param>
/// <param name="TemperatureCelsius">Null without administrative rights, or when the drive reports none.</param>
public sealed record VolumeHealth(string HealthStatus, double? TemperatureCelsius);

/// <summary>
/// Drive health and temperature per volume, from the Windows Storage Management API.
///
/// This is Windows' own verdict — the one "Get-PhysicalDisk" prints, built from the drive's SMART
/// predictive-failure flag and the storage driver's view — and it is readable without the
/// privileged helper. The helper's <c>disk.smart-health</c> goes further, to individual SMART
/// attributes, and stays an explicit, on-demand command.
///
/// The queries are slow (hundreds of milliseconds) and the answers change over days, so the result
/// is cached for five minutes rather than paid for on every five-second sample.
///
/// A volume spanning several drives reports its worst drive and its hottest.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class StorageHealthReader
{
    public static readonly TimeSpan RefreshInterval = TimeSpan.FromMinutes(5);
    private const string Scope = @"\\.\root\Microsoft\Windows\Storage";

    private IReadOnlyDictionary<string, VolumeHealth> _cached = new Dictionary<string, VolumeHealth>();
    private DateTimeOffset _readAt = DateTimeOffset.MinValue;

    /// <summary>Why temperature is missing, when it is; shown to nobody but the logs and tests.</summary>
    public string? TemperatureUnavailableReason { get; private set; }

    public IReadOnlyDictionary<string, VolumeHealth> Read(DateTimeOffset now)
    {
        if (now - _readAt < RefreshInterval)
        {
            return _cached;
        }

        _readAt = now;
        try
        {
            _cached = Query();
        }
        catch (Exception ex) when (ex is ManagementException or UnauthorizedAccessException or System.Runtime.InteropServices.COMException)
        {
            // Storage Management is missing on some SKUs and broken on some machines. Every volume
            // then reports "unknown", which the schema already means.
            _cached = new Dictionary<string, VolumeHealth>();
        }

        return _cached;
    }

    /// <summary>MSFT_PhysicalDisk / MSFT_Disk HealthStatus to the schema's words.</summary>
    public static string MapHealth(ushort? status) => status switch
    {
        0 => "healthy",
        1 => "warning",
        2 => "failing",
        _ => "unknown",
    };

    private static int Severity(string health) => health switch
    {
        "failing" => 3,
        "warning" => 2,
        "healthy" => 1,
        _ => 0,
    };

    private Dictionary<string, VolumeHealth> Query()
    {
        var scope = new ManagementScope(Scope);
        scope.Connect();

        var physicalHealth = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (ManagementBaseObject disk in Select(scope, "SELECT DeviceId, HealthStatus FROM MSFT_PhysicalDisk"))
        {
            using (disk)
            {
                if (disk["DeviceId"] is string id)
                {
                    physicalHealth[id] = MapHealth(disk["HealthStatus"] as ushort?);
                }
            }
        }

        // A virtual disk (Storage Spaces) has a disk number with no physical disk of the same id; its
        // own health is the best available answer for the volumes on it.
        var diskHealth = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (ManagementBaseObject disk in Select(scope, "SELECT Number, HealthStatus FROM MSFT_Disk"))
        {
            using (disk)
            {
                if (disk["Number"] is uint number)
                {
                    diskHealth[number.ToString(System.Globalization.CultureInfo.InvariantCulture)] = MapHealth(disk["HealthStatus"] as ushort?);
                }
            }
        }

        Dictionary<string, double> temperatures = QueryTemperatures(scope);

        var volumes = new Dictionary<string, VolumeHealth>(StringComparer.OrdinalIgnoreCase);
        foreach (ManagementBaseObject partition in Select(scope, "SELECT DriveLetter, DiskNumber FROM MSFT_Partition"))
        {
            using (partition)
            {
                char letter = partition["DriveLetter"] switch
                {
                    char value => value,
                    ushort value => (char)value,
                    _ => '\0',
                };

                if (letter == '\0' || partition["DiskNumber"] is not uint diskNumber)
                {
                    continue;
                }

                string id = diskNumber.ToString(System.Globalization.CultureInfo.InvariantCulture);
                string health = physicalHealth.TryGetValue(id, out string? physical)
                    ? physical
                    : diskHealth.GetValueOrDefault(id, "unknown");
                double? temperature = temperatures.TryGetValue(id, out double celsius) ? celsius : null;

                string volume = $"{char.ToUpperInvariant(letter)}:";
                volumes[volume] = volumes.TryGetValue(volume, out VolumeHealth? existing)
                    ? new VolumeHealth(
                        Severity(existing.HealthStatus) >= Severity(health) ? existing.HealthStatus : health,
                        MaxOrNull(existing.TemperatureCelsius, temperature))
                    : new VolumeHealth(health, temperature);
            }
        }

        return volumes;
    }

    /// <summary>
    /// Drive temperatures from the reliability counters. Needs administrative rights, which the
    /// agent service has and an ordinary test run does not; without them the answer is null.
    /// </summary>
    private Dictionary<string, double> QueryTemperatures(ManagementScope scope)
    {
        var temperatures = new Dictionary<string, double>(StringComparer.Ordinal);
        try
        {
            foreach (ManagementBaseObject counter in Select(scope, "SELECT DeviceId, Temperature FROM MSFT_StorageReliabilityCounter"))
            {
                using (counter)
                {
                    // Zero is a drive that does not report temperature, not one at freezing point.
                    if (counter["DeviceId"] is string id && counter["Temperature"] is byte celsius && celsius > 0)
                    {
                        temperatures[id] = celsius;
                    }
                }
            }

            TemperatureUnavailableReason = temperatures.Count == 0 ? "No drive reported a temperature." : null;
        }
        catch (Exception ex) when (ex is ManagementException or UnauthorizedAccessException)
        {
            TemperatureUnavailableReason = $"Drive temperatures need administrative rights: {ex.Message}";
        }

        return temperatures;
    }

    private static double? MaxOrNull(double? left, double? right) =>
        left is null ? right : right is null ? left : Math.Max(left.Value, right.Value);

    private static IEnumerable<ManagementBaseObject> Select(ManagementScope scope, string query)
    {
        using var searcher = new ManagementObjectSearcher(scope, new ObjectQuery(query));
        using ManagementObjectCollection results = searcher.Get();
        foreach (ManagementBaseObject result in results)
        {
            yield return result;
        }
    }
}
