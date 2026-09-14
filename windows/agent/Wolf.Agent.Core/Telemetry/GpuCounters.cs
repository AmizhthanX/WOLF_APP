using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.Versioning;
using System.Text.RegularExpressions;

namespace Wolf.Agent.Core.Telemetry;

/// <summary>
/// One instance of the "GPU Engine" performance counter: one process's use of one engine.
/// </summary>
public readonly partial record struct GpuEngineInstance(int Pid, string Luid, int Physical, int Engine, string EngineType)
{
    [GeneratedRegex(@"^pid_(\d+)_luid_(0x[0-9A-Fa-f]{8}_0x[0-9A-Fa-f]{8})_phys_(\d+)_eng_(\d+)_engtype_(.*)$")]
    private static partial Regex EnginePattern();

    [GeneratedRegex(@"^pid_(\d+)_luid_(0x[0-9A-Fa-f]{8}_0x[0-9A-Fa-f]{8})_phys_(\d+)$")]
    private static partial Regex ProcessMemoryPattern();

    [GeneratedRegex(@"^luid_(0x[0-9A-Fa-f]{8}_0x[0-9A-Fa-f]{8})_phys_(\d+)$")]
    private static partial Regex AdapterMemoryPattern();

    public static bool TryParse(string instance, out GpuEngineInstance parsed)
    {
        Match match = EnginePattern().Match(instance);
        if (!match.Success ||
            !int.TryParse(match.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture, out int pid) ||
            !int.TryParse(match.Groups[3].Value, NumberStyles.None, CultureInfo.InvariantCulture, out int physical) ||
            !int.TryParse(match.Groups[4].Value, NumberStyles.None, CultureInfo.InvariantCulture, out int engine))
        {
            parsed = default;
            return false;
        }

        parsed = new GpuEngineInstance(pid, match.Groups[2].Value.ToUpperInvariant().Replace("0X", "0x"), physical, engine, match.Groups[5].Value);
        return true;
    }

    /// <summary>"pid_…_luid_…_phys_…" from the "GPU Process Memory" category.</summary>
    public static bool TryParseProcessMemory(string instance, out int pid, out string luid)
    {
        Match match = ProcessMemoryPattern().Match(instance);
        pid = 0;
        luid = string.Empty;
        if (!match.Success || !int.TryParse(match.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture, out pid))
        {
            return false;
        }

        luid = match.Groups[2].Value.ToUpperInvariant().Replace("0X", "0x");
        return true;
    }

    /// <summary>"luid_…_phys_…" from the "GPU Adapter Memory" category.</summary>
    public static bool TryParseAdapterMemory(string instance, out string luid)
    {
        Match match = AdapterMemoryPattern().Match(instance);
        luid = match.Success ? match.Groups[1].Value.ToUpperInvariant().Replace("0X", "0x") : string.Empty;
        return match.Success;
    }
}

/// <summary>Load on one adapter, by engine family. Null means the adapter has no engine of that family.</summary>
public sealed record AdapterUtilization(
    double UsagePercent,
    double? GraphicsPercent,
    double? ComputePercent,
    double? VideoEncodePercent,
    double? VideoDecodePercent);

/// <summary>GPU load for every adapter and every process that used one.</summary>
public sealed record GpuUtilization(
    IReadOnlyDictionary<string, AdapterUtilization> ByAdapterLuid,
    IReadOnlyDictionary<int, double> ByProcess);

/// <summary>
/// Turning per-process, per-engine counters into the numbers Task Manager shows.
///
/// Pure, so the arithmetic is tested without a GPU. The rules are Task Manager's, deliberately —
/// an owner comparing WOLF with Task Manager on the same machine should see the same figure:
///
/// - an engine's load is the sum of every process's load on it, capped at 100%;
/// - an adapter's load is its <em>busiest</em> engine, not the sum or the mean — a GPU whose 3D
///   engine is pegged is a busy GPU even while its eight other engines idle;
/// - a process's load is its busiest engine, for the same reason.
/// </summary>
public static class GpuUtilizationMath
{
    public static GpuUtilization Summarise(IEnumerable<(GpuEngineInstance Instance, double Percent)> readings)
    {
        var engines = new Dictionary<(string Luid, int Physical, int Engine), (string Type, double Percent)>();
        var processes = new Dictionary<int, double>();

        foreach ((GpuEngineInstance instance, double raw) in readings)
        {
            if (double.IsNaN(raw) || double.IsInfinity(raw))
            {
                continue;
            }

            double percent = Math.Clamp(raw, 0, 100);
            var key = (instance.Luid, instance.Physical, instance.Engine);
            engines[key] = engines.TryGetValue(key, out var existing)
                ? (existing.Type, Math.Min(100, existing.Percent + percent))
                : (instance.EngineType, percent);

            processes[instance.Pid] = processes.TryGetValue(instance.Pid, out double current)
                ? Math.Max(current, percent)
                : percent;
        }

        var adapters = new Dictionary<string, AdapterUtilization>(StringComparer.Ordinal);

        foreach (IGrouping<string, KeyValuePair<(string Luid, int Physical, int Engine), (string Type, double Percent)>> adapter in engines.GroupBy(entry => entry.Key.Luid))
        {
            double? Family(Func<string, bool> matches)
            {
                double[] values = adapter.Where(entry => matches(entry.Value.Type)).Select(entry => entry.Value.Percent).ToArray();
                return values.Length == 0 ? null : values.Max();
            }

            adapters[adapter.Key] = new AdapterUtilization(
                UsagePercent: adapter.Max(entry => entry.Value.Percent),
                GraphicsPercent: Family(type => type == "3D" || type.StartsWith("Graphics", StringComparison.OrdinalIgnoreCase)),
                ComputePercent: Family(type => type.StartsWith("Compute", StringComparison.OrdinalIgnoreCase) || type.Equals("Cuda", StringComparison.OrdinalIgnoreCase)),
                VideoEncodePercent: Family(type => type.StartsWith("VideoEncode", StringComparison.OrdinalIgnoreCase)),
                VideoDecodePercent: Family(type => type.StartsWith("VideoDecode", StringComparison.OrdinalIgnoreCase)));
        }

        return new GpuUtilization(adapters, processes);
    }
}

/// <summary>What one read of the GPU counters found.</summary>
/// <param name="Utilization">Null on the first read: load is a rate, and a rate needs two readings.</param>
/// <param name="ProcessesWithEngines">
/// Every process holding a GPU engine now, whether or not it has a rate yet. A process in here but
/// not in <see cref="GpuUtilization.ByProcess"/> started using the GPU since the last read, and its
/// load is unknown - not zero. A process in neither is using no GPU engine at all, which is zero.
/// </param>
/// <param name="DedicatedBytesByLuid">Null when this Windows does not publish the category.</param>
/// <param name="DedicatedBytesByProcess">Null when this Windows does not publish the category.</param>
public sealed record GpuCounterSnapshot(
    GpuUtilization? Utilization,
    IReadOnlySet<int> ProcessesWithEngines,
    IReadOnlyDictionary<string, long>? DedicatedBytesByLuid,
    IReadOnlyDictionary<int, long>? DedicatedBytesByProcess)
{
    /// <summary>A process's GPU load: a rate, zero for a process with no engine, or null when unknown.</summary>
    public double? ProcessPercent(int pid)
    {
        if (Utilization is null) return null;
        if (Utilization.ByProcess.TryGetValue(pid, out double percent)) return percent;
        return ProcessesWithEngines.Contains(pid) ? null : 0;
    }

    /// <summary>A process's dedicated GPU memory, zero when it holds none, null when unknowable.</summary>
    public long? ProcessDedicatedBytes(int pid) =>
        DedicatedBytesByProcess is null ? null : DedicatedBytesByProcess.GetValueOrDefault(pid);
}

/// <summary>
/// Reads the GPU performance counters Windows (WDDM 2.x, Windows 10 1709 and later) publishes.
///
/// A whole category is read in one call rather than through a counter object per instance: this
/// machine has four hundred engine instances and they churn with every process that touches the
/// GPU, so per-instance counters would be both slow and a leak.
///
/// Not thread-safe; each consumer holds its own reader, because the load it reports is "since this
/// reader last looked".
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class GpuCounterReader
{
    private const string EngineCategory = "GPU Engine";
    private const string AdapterMemoryCategory = "GPU Adapter Memory";
    private const string ProcessMemoryCategory = "GPU Process Memory";

    private Dictionary<string, CounterSample> _previous = new(StringComparer.Ordinal);
    private bool? _available;

    /// <summary>Why counters are unavailable, when they are.</summary>
    public string? UnavailableReason { get; private set; }

    /// <summary>Null when this Windows publishes no GPU counters at all.</summary>
    public GpuCounterSnapshot? Read()
    {
        if (_available == false)
        {
            return null;
        }

        try
        {
            if (_available is null)
            {
                _available = PerformanceCounterCategory.Exists(EngineCategory);
                if (_available == false)
                {
                    UnavailableReason = "This Windows publishes no GPU Engine performance counters (WDDM 2.0 or later is required).";
                    return null;
                }
            }

            (GpuUtilization? utilization, HashSet<int> seen) = ReadUtilization();
            return new GpuCounterSnapshot(utilization, seen, ReadAdapterMemory(), ReadProcessMemory());
        }
        catch (Exception ex) when (ex is InvalidOperationException or Win32Exception or UnauthorizedAccessException)
        {
            UnavailableReason = $"The GPU performance counters could not be read: {ex.Message}";
            return new GpuCounterSnapshot(null, new HashSet<int>(), null, null);
        }
    }

    private (GpuUtilization?, HashSet<int>) ReadUtilization()
    {
        InstanceDataCollection? utilization = new PerformanceCounterCategory(EngineCategory)
            .ReadCategory()["Utilization Percentage"];

        var current = new Dictionary<string, CounterSample>(StringComparer.Ordinal);
        var readings = new List<(GpuEngineInstance, double)>();
        var seen = new HashSet<int>();
        bool hadPrevious = _previous.Count > 0;

        if (utilization is not null)
        {
            foreach (InstanceData data in utilization.Values)
            {
                current[data.InstanceName] = data.Sample;
                if (GpuEngineInstance.TryParse(data.InstanceName, out GpuEngineInstance present))
                {
                    seen.Add(present.Pid);
                }

                // A process that started using the GPU since the last read has no earlier sample to
                // difference against; its load is counted from the next read.
                if (_previous.TryGetValue(data.InstanceName, out CounterSample earlier) &&
                    GpuEngineInstance.TryParse(data.InstanceName, out GpuEngineInstance instance))
                {
                    readings.Add((instance, CounterSample.Calculate(earlier, data.Sample)));
                }
            }
        }

        _previous = current;
        return (hadPrevious ? GpuUtilizationMath.Summarise(readings) : null, seen);
    }

    private static Dictionary<string, long>? ReadAdapterMemory()
    {
        var totals = new Dictionary<string, long>(StringComparer.Ordinal);
        if (!PerformanceCounterCategory.Exists(AdapterMemoryCategory))
        {
            return null;
        }

        InstanceDataCollection? dedicated = new PerformanceCounterCategory(AdapterMemoryCategory).ReadCategory()["Dedicated Usage"];
        if (dedicated is null)
        {
            return totals;
        }

        foreach (InstanceData data in dedicated.Values)
        {
            if (GpuEngineInstance.TryParseAdapterMemory(data.InstanceName, out string luid))
            {
                totals[luid] = totals.GetValueOrDefault(luid) + data.RawValue;
            }
        }

        return totals;
    }

    private static Dictionary<int, long>? ReadProcessMemory()
    {
        var totals = new Dictionary<int, long>();
        if (!PerformanceCounterCategory.Exists(ProcessMemoryCategory))
        {
            return null;
        }

        InstanceDataCollection? dedicated = new PerformanceCounterCategory(ProcessMemoryCategory).ReadCategory()["Dedicated Usage"];
        if (dedicated is null)
        {
            return totals;
        }

        foreach (InstanceData data in dedicated.Values)
        {
            if (GpuEngineInstance.TryParseProcessMemory(data.InstanceName, out int pid, out _))
            {
                totals[pid] = totals.GetValueOrDefault(pid) + data.RawValue;
            }
        }

        return totals;
    }
}
