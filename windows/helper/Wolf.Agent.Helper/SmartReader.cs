using System.Management;
using System.Runtime.Versioning;
using Microsoft.Extensions.Logging;
using Wolf.Agent.Core.Privileged;

namespace Wolf.Agent.Helper;

/// <summary>
/// Reads what the drives in this PC say about their own health.
///
/// Two sources, because neither is enough on its own. `MSStorageDriver_FailurePredictData`
/// carries the raw SMART attribute table — the numbers a person recognises, like hours
/// powered on and sectors reallocated — but says nothing about which drive it came from
/// beyond an instance name. `Win32_DiskDrive` knows the model, serial, size and bus, and
/// carries Windows' own one-word verdict. Joined on the PNP device id, they answer both
/// "which drive" and "how is it doing".
///
/// Both need administrative rights, which is the whole reason this runs in the helper.
///
/// **`unknown` is a real answer and a common one.** A USB enclosure that does not pass SMART
/// through, a RAID member behind a controller, a virtual disk in a VM — none of them will
/// answer, and saying "healthy" because nothing said otherwise would be inventing
/// reassurance about somebody's data.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class SmartReader
{
    /// <summary>Where the storage driver publishes SMART data. Not the default WMI namespace.</summary>
    private const string WmiScope = @"\\.\root\wmi";

    private readonly ILogger<SmartReader> _logger;

    public SmartReader(ILogger<SmartReader> logger)
    {
        _logger = logger;
    }

    /// <summary>Health for every drive, or for one when a device id is given.</summary>
    public IReadOnlyList<HelperDiskHealth> Read(string? deviceId)
    {
        Dictionary<string, byte[]> smartByPnpId = ReadSmartTables();
        Dictionary<string, byte[]> thresholdsByPnpId = ReadThresholdTables();
        Dictionary<string, bool> predictedFailure = ReadFailurePredictStatus();

        var disks = new List<HelperDiskHealth>();

        foreach (ManagementObject drive in QueryDrives())
        {
            using (drive)
            {
                string id = AsString(drive["DeviceID"]) ?? string.Empty;
                if (id.Length == 0) continue;
                if (deviceId is not null && !string.Equals(id, deviceId, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                string? pnpId = AsString(drive["PNPDeviceID"]);
                byte[]? table = pnpId is not null ? Lookup(smartByPnpId, pnpId) : null;
                byte[]? thresholds = pnpId is not null ? Lookup(thresholdsByPnpId, pnpId) : null;
                bool? predicted = pnpId is not null ? LookupFlag(predictedFailure, pnpId) : null;

                disks.Add(Describe(drive, id, table, thresholds, predicted));
            }
        }

        return disks;
    }

    private static HelperDiskHealth Describe(
        ManagementObject drive,
        string deviceId,
        byte[]? smartTable,
        byte[]? thresholdTable,
        bool? predictedFailure)
    {
        IReadOnlyList<HelperSmartAttribute> attributes = smartTable is null
            ? Array.Empty<HelperSmartAttribute>()
            : SmartAttributes.Parse(smartTable);

        // Thresholds arrive as their own table, and a drive can report attributes while
        // refusing them. Without them nothing is claimed to be failing, which is the honest
        // reading of "the drive did not say what counts as failed".
        if (thresholdTable is not null)
        {
            attributes = SmartAttributes.WithThresholds(attributes, thresholdTable);
        }

        (string status, string summary) = Verdict(drive, attributes, predictedFailure, smartTable is not null);

        return new HelperDiskHealth(
            DeviceId: deviceId,
            Model: AsString(drive["Model"]),
            SerialNumber: AsString(drive["SerialNumber"])?.Trim(),
            Firmware: AsString(drive["FirmwareRevision"])?.Trim(),
            SizeBytes: AsLong(drive["Size"]),
            BusType: AsString(drive["InterfaceType"]),
            SolidState: null,
            Status: status,
            Summary: summary,
            TemperatureCelsius: SmartAttributes.Temperature(attributes),
            PowerOnHours: SmartAttributes.PowerOnHours(attributes),
            Attributes: attributes);
    }

    /// <summary>
    /// Turn what the drive said into one word and one sentence.
    ///
    /// The order matters. An attribute at or below its failure threshold is the drive itself
    /// saying it is going; that outranks Windows' summary status, which is coarse and has
    /// been known to stay "OK" while attributes are already failing. Wear on a drive that is
    /// not yet failing is a warning, because it is the thing somebody would want notice of
    /// rather than a surprise.
    /// </summary>
    private static (string Status, string Summary) Verdict(
        ManagementObject drive,
        IReadOnlyList<HelperSmartAttribute> attributes,
        bool? predictedFailure,
        bool smartAvailable)
    {
        HelperSmartAttribute[] failing = attributes.Where(attribute => attribute.Failing).ToArray();

        if (failing.Length > 0)
        {
            string names = string.Join(", ", failing.Take(3).Select(attribute => attribute.Name));
            return ("failing", $"The drive reports {failing.Length} attribute(s) past their failure threshold: {names}.");
        }

        if (predictedFailure == true)
        {
            return ("failing", "The drive is predicting its own failure. Back it up and replace it.");
        }

        if (!smartAvailable)
        {
            string? status = AsString(drive["Status"]);
            return status is "OK"
                ? ("unknown",
                   "This drive does not report SMART data to Windows — common for USB enclosures, " +
                   "RAID members and virtual disks. Windows itself reports no fault.")
                : ("unknown",
                   "This drive does not report SMART data to Windows, so WOLF cannot say how it is doing.");
        }

        HelperSmartAttribute[] worn = attributes
            .Where(attribute => attribute.Prefail && attribute.Value <= attribute.Threshold + 10)
            .ToArray();

        if (worn.Length > 0)
        {
            string names = string.Join(", ", worn.Take(3).Select(attribute => attribute.Name));
            return ("warning", $"Approaching the failure threshold on: {names}.");
        }

        // Reallocated sectors are the classic early sign, and a drive with a handful of them
        // is not failing yet — but it is not something to find out about later either.
        HelperSmartAttribute? reallocated = attributes.FirstOrDefault(attribute => attribute.Id == 5);
        if (reallocated is not null && reallocated.Raw > 0)
        {
            return ("warning", $"{reallocated.Raw:F0} reallocated sector(s). Worth watching.");
        }

        return ("healthy", "No SMART attribute is near its failure threshold.");
    }

    private IEnumerable<ManagementObject> QueryDrives()
    {
        ManagementObjectCollection results;

        try
        {
            using var searcher = new ManagementObjectSearcher(
                "SELECT DeviceID, PNPDeviceID, Model, SerialNumber, FirmwareRevision, Size, InterfaceType, Status " +
                "FROM Win32_DiskDrive");
            results = searcher.Get();
        }
        catch (ManagementException ex)
        {
            _logger.LogError(ex, "Could not enumerate physical drives.");
            yield break;
        }

        foreach (ManagementBaseObject item in results)
        {
            if (item is ManagementObject drive) yield return drive;
        }
    }

    /// <summary>
    /// The raw SMART attribute tables, keyed by the drive's PNP device id.
    ///
    /// This is the class that needs administrator. Without it the query does not fail
    /// informatively — it returns nothing at all, which is why an empty result is reported as
    /// "no SMART data" rather than as a healthy drive.
    /// </summary>
    private Dictionary<string, byte[]> ReadSmartTables()
    {
        var tables = new Dictionary<string, byte[]>(StringComparer.OrdinalIgnoreCase);

        try
        {
            using var searcher = new ManagementObjectSearcher(
                WmiScope,
                "SELECT InstanceName, VendorSpecific FROM MSStorageDriver_FailurePredictData");

            foreach (ManagementBaseObject item in searcher.Get())
            {
                using (item)
                {
                    string? instance = AsString(item["InstanceName"]);
                    if (instance is null) continue;
                    if (item["VendorSpecific"] is byte[] data) tables[Normalise(instance)] = data;
                }
            }
        }
        catch (ManagementException ex)
        {
            // Not fatal: a machine where no drive supports SMART reports exactly this, and
            // so does one where the query was refused. Both mean "no data", which is what
            // the caller is told.
            _logger.LogInformation("SMART attribute data is not available on this PC: {Message}", ex.Message);
        }
        catch (UnauthorizedAccessException)
        {
            _logger.LogError("Reading SMART data was refused; the helper is not running with enough rights.");
        }

        return tables;
    }

    /// <summary>The vendor threshold tables, keyed the same way as the attribute tables.</summary>
    private Dictionary<string, byte[]> ReadThresholdTables()
    {
        var tables = new Dictionary<string, byte[]>(StringComparer.OrdinalIgnoreCase);

        try
        {
            using var searcher = new ManagementObjectSearcher(
                WmiScope,
                "SELECT InstanceName, VendorSpecific FROM MSStorageDriver_FailurePredictThresholds");

            foreach (ManagementBaseObject item in searcher.Get())
            {
                using (item)
                {
                    string? instance = AsString(item["InstanceName"]);
                    if (instance is null) continue;
                    if (item["VendorSpecific"] is byte[] data) tables[Normalise(instance)] = data;
                }
            }
        }
        catch (ManagementException ex)
        {
            _logger.LogDebug("SMART thresholds are not available: {Message}", ex.Message);
        }
        catch (UnauthorizedAccessException)
        {
            _logger.LogError("Reading SMART thresholds was refused.");
        }

        return tables;
    }

    /// <summary>The drive's own one-bit "I am about to fail" flag, where it exposes one.</summary>
    private Dictionary<string, bool> ReadFailurePredictStatus()
    {
        var flags = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);

        try
        {
            using var searcher = new ManagementObjectSearcher(
                WmiScope,
                "SELECT InstanceName, PredictFailure FROM MSStorageDriver_FailurePredictStatus");

            foreach (ManagementBaseObject item in searcher.Get())
            {
                using (item)
                {
                    string? instance = AsString(item["InstanceName"]);
                    if (instance is null) continue;
                    if (item["PredictFailure"] is bool predict) flags[Normalise(instance)] = predict;
                }
            }
        }
        catch (ManagementException ex)
        {
            _logger.LogDebug("Failure-prediction status is not available: {Message}", ex.Message);
        }
        catch (UnauthorizedAccessException)
        {
            _logger.LogError("Reading failure-prediction status was refused.");
        }

        return flags;
    }

    /// <summary>
    /// Match a WMI instance name to a PNP device id.
    ///
    /// They describe the same device and are formatted differently: the instance name has a
    /// trailing enumerator suffix and uses different separators depending on the driver. So
    /// the join is on a normalised form and, failing that, on one being a prefix of the
    /// other — which is what actually works across the storage drivers in the wild.
    /// </summary>
    private static byte[]? Lookup(Dictionary<string, byte[]> tables, string pnpId)
    {
        string key = Normalise(pnpId);
        if (tables.TryGetValue(key, out byte[]? exact)) return exact;

        foreach (KeyValuePair<string, byte[]> entry in tables)
        {
            if (entry.Key.StartsWith(key, StringComparison.OrdinalIgnoreCase) ||
                key.StartsWith(entry.Key, StringComparison.OrdinalIgnoreCase))
            {
                return entry.Value;
            }
        }

        return null;
    }

    private static bool? LookupFlag(Dictionary<string, bool> flags, string pnpId)
    {
        string key = Normalise(pnpId);
        if (flags.TryGetValue(key, out bool exact)) return exact;

        foreach (KeyValuePair<string, bool> entry in flags)
        {
            if (entry.Key.StartsWith(key, StringComparison.OrdinalIgnoreCase) ||
                key.StartsWith(entry.Key, StringComparison.OrdinalIgnoreCase))
            {
                return entry.Value;
            }
        }

        return null;
    }

    /// <summary>Strip the separators and the trailing enumerator suffix the two forms differ by.</summary>
    internal static string Normalise(string identifier)
    {
        string trimmed = identifier.Trim();

        // Instance names end with "_0" and similar; device ids do not.
        int suffix = trimmed.LastIndexOf('_');
        if (suffix > 0 && suffix > trimmed.Length - 4) trimmed = trimmed[..suffix];

        return trimmed.Replace("\\", string.Empty, StringComparison.Ordinal)
            .Replace("&", string.Empty, StringComparison.Ordinal)
            .ToUpperInvariant();
    }

    private static string? AsString(object? value)
    {
        string? text = value?.ToString();
        return string.IsNullOrWhiteSpace(text) ? null : text;
    }

    private static long? AsLong(object? value) =>
        value is null ? null : long.TryParse(value.ToString(), out long parsed) ? parsed : null;
}
