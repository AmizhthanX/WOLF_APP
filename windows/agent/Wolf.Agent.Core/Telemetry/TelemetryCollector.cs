using System.ComponentModel;
using System.Diagnostics;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Microsoft.Extensions.Logging;
using Wolf.Agent.Core.Native;
using Wolf.Agent.Core.Protocol;

namespace Wolf.Agent.Core.Telemetry;

/// <summary>
/// Samples the machine's live metrics.
///
/// Two rules govern this class. First, a counter WOLF cannot read is reported as null,
/// never as zero — a dashboard that shows 0 °C for a missing sensor is worse than one that
/// shows nothing. Second, sampling itself must stay cheap: the agent is judged partly on
/// how little it disturbs the machine it monitors, so counters are created once and reused,
/// and anything that would need a per-sample WMI query is left out until it can be done
/// affordably.
///
/// GPUs come from the display kernel (names, dedicated memory, temperature where the driver reports
/// one) and the GPU Engine counters (load per engine family) - see <see cref="GpuAdapters"/> and
/// <see cref="GpuCounterReader"/>. Drive health is Windows' own verdict per volume, cached for five
/// minutes - see <see cref="StorageHealthReader"/>.
///
/// Not yet sampled, and therefore honestly absent rather than faked: CPU package power and CPU
/// temperature (needs a kernel driver or vendor SDK), GPU clock speeds, fan and power in watts
/// (vendor SDKs; the display kernel reports power only as a share of the limit), and thermal zones.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class TelemetryCollector : IDisposable
{
    private readonly ILogger<TelemetryCollector> _logger;
    private readonly Process _self = Process.GetCurrentProcess();

    private PerformanceCounter? _cpuTotal;
    private PerformanceCounter? _cpuQueue;
    private readonly List<(string Instance, PerformanceCounter Counter)> _cpuPerCore = new();
    private readonly Dictionary<string, (PerformanceCounter Read, PerformanceCounter Write, PerformanceCounter Active, PerformanceCounter Queue)> _diskCounters = new(StringComparer.OrdinalIgnoreCase);
    private PerformanceCounter? _committedBytes;
    private PerformanceCounter? _cachedBytes;

    private readonly Dictionary<string, (long Received, long Sent, DateTimeOffset At)> _networkPrevious = new(StringComparer.Ordinal);
    private TimeSpan _previousSelfCpu;
    private DateTimeOffset _previousSelfAt = DateTimeOffset.UtcNow;
    private bool _countersAvailable;
    private readonly GpuCounterReader _gpuCounters = new();
    private readonly StorageHealthReader _storageHealth = new();
    private bool _gpuEnumerationFailed;

    public TelemetryCollector(ILogger<TelemetryCollector> logger)
    {
        _logger = logger;
        InitializeCounters();
    }

    private void InitializeCounters()
    {
        try
        {
            _cpuTotal = new PerformanceCounter("Processor Information", "% Processor Time", "_Total", readOnly: true);
            _cpuQueue = new PerformanceCounter("System", "Processor Queue Length", readOnly: true);
            _committedBytes = new PerformanceCounter("Memory", "Committed Bytes", readOnly: true);
            _cachedBytes = new PerformanceCounter("Memory", "Cache Bytes", readOnly: true);

            var processorCategory = new PerformanceCounterCategory("Processor Information");
            foreach (string instance in processorCategory.GetInstanceNames())
            {
                // "_Total" and per-socket totals like "0,_Total" are aggregates, not cores.
                if (instance.Contains("_Total", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                _cpuPerCore.Add((
                    instance,
                    new PerformanceCounter("Processor Information", "% Processor Time", instance, readOnly: true)));
            }

            // Prime the counters: the first read of a rate counter is always zero.
            _cpuTotal.NextValue();
            foreach ((_, PerformanceCounter counter) in _cpuPerCore)
            {
                counter.NextValue();
            }

            _countersAvailable = true;
        }
        catch (Exception ex) when (ex is InvalidOperationException or UnauthorizedAccessException or Win32Exception)
        {
            // Performance counters can be disabled or corrupted on a given machine. WOLF
            // keeps working and reports the affected metrics as unavailable.
            _logger.LogWarning(ex, "Windows performance counters are unavailable; CPU and disk rates will be reported as unknown.");
            _countersAvailable = false;
        }
    }

    public TelemetrySample Collect()
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        return new TelemetrySample(
            SampledAt: now.ToString("o"),
            UptimeSeconds: Environment.TickCount64 / 1000.0,
            Cpu: CollectCpu(),
            Memory: CollectMemory(),
            Gpus: CollectGpus(),
            Disks: CollectDisks(now),
            Networks: CollectNetworks(now),
            Thermal: Array.Empty<ThermalSample>(),
            Battery: CollectBattery(),
            Agent: CollectSelf(now));
    }

    private CpuSample CollectCpu()
    {
        double? usage = null;
        double? queue = null;
        var perCore = new List<double>();

        if (_countersAvailable)
        {
            try
            {
                // "% Processor Time" on Processor Information can exceed 100 on turbo-boosted
                // cores; clamping keeps the value inside the schema's 0-100 range without
                // pretending the machine was idle.
                usage = Math.Clamp(_cpuTotal!.NextValue(), 0, 100);
                queue = _cpuQueue!.NextValue();
                foreach ((_, PerformanceCounter counter) in _cpuPerCore)
                {
                    perCore.Add(Math.Clamp(counter.NextValue(), 0, 100));
                }
            }
            catch (Exception ex) when (ex is InvalidOperationException or Win32Exception)
            {
                _logger.LogDebug(ex, "CPU counters became unreadable.");
                usage = null;
                queue = null;
                perCore.Clear();
            }
        }

        return new CpuSample(
            UsagePercent: usage,
            PerCorePercent: perCore,
            // Current frequency needs a vendor interface; the schema keeps it nullable.
            FrequencyMhz: null,
            TemperatureCelsius: null,
            QueueLength: queue,
            PackagePowerWatts: null);
    }

    private MemorySample CollectMemory()
    {
        var status = new NativeMethods.MemoryStatusEx
        {
            dwLength = (uint)Marshal.SizeOf<NativeMethods.MemoryStatusEx>(),
        };

        if (!NativeMethods.GlobalMemoryStatusEx(ref status))
        {
            return new MemorySample(null, null, null, null, null, null);
        }

        long total = (long)status.ullTotalPhys;
        long available = (long)status.ullAvailPhys;

        long? committed = null;
        long? cached = null;
        if (_countersAvailable)
        {
            try
            {
                committed = (long)_committedBytes!.NextValue();
                cached = (long)_cachedBytes!.NextValue();
            }
            catch (Exception ex) when (ex is InvalidOperationException or Win32Exception)
            {
                _logger.LogDebug(ex, "Memory counters became unreadable.");
            }
        }

        return new MemorySample(
            TotalBytes: total,
            UsedBytes: total - available,
            AvailableBytes: available,
            CommittedBytes: committed,
            CommitLimitBytes: (long)status.ullTotalPageFile,
            CachedBytes: cached);
    }

    private IReadOnlyList<GpuSample> CollectGpus()
    {
        if (_gpuEnumerationFailed)
        {
            return Array.Empty<GpuSample>();
        }

        IReadOnlyList<GpuAdapter> adapters;
        try
        {
            adapters = GpuAdapters.Enumerate();
        }
        catch (Exception ex) when (ex is DllNotFoundException or EntryPointNotFoundException)
        {
            // Windows before 8 has no D3DKMTEnumAdapters2. Stop asking rather than failing every tick.
            _logger.LogWarning(ex, "GPU enumeration is unavailable on this Windows; GPUs will not be reported.");
            _gpuEnumerationFailed = true;
            return Array.Empty<GpuSample>();
        }

        if (adapters.Count == 0)
        {
            return Array.Empty<GpuSample>();
        }

        GpuCounterSnapshot? counters = _gpuCounters.Read();
        var samples = new List<GpuSample>();

        foreach (GpuAdapter adapter in adapters.Take(8))
        {
            // Null - not zero - until the counters have a rate for this adapter: the first tick after
            // start, or an adapter no process has opened.
            AdapterUtilization? load = counters?.Utilization?.ByAdapterLuid.GetValueOrDefault(adapter.Luid);
            long? used = counters?.DedicatedBytesByLuid is { } memory && memory.TryGetValue(adapter.Luid, out long bytes)
                ? bytes
                : null;

            samples.Add(new GpuSample(
                AdapterId: adapter.AdapterId,
                Name: adapter.Name,
                UsagePercent: load?.UsagePercent,
                GraphicsEnginePercent: load?.GraphicsPercent,
                ComputeEnginePercent: load?.ComputePercent,
                VideoEncodeEnginePercent: load?.VideoEncodePercent,
                VideoDecodeEnginePercent: load?.VideoDecodePercent,
                VramTotalBytes: adapter.DedicatedVideoMemoryBytes,
                VramUsedBytes: used,
                TemperatureCelsius: adapter.TemperatureCelsius is double celsius ? Math.Clamp(celsius, -50, 150) : null,
                CoreClockMhz: null,
                MemoryClockMhz: null,
                FanPercent: null,
                PowerWatts: null));
        }

        return samples;
    }

    private IReadOnlyList<DiskSample> CollectDisks(DateTimeOffset now)
    {
        var samples = new List<DiskSample>();
        IReadOnlyDictionary<string, VolumeHealth> health = _storageHealth.Read(now);

        foreach (DriveInfo drive in DriveInfo.GetDrives())
        {
            if (drive.DriveType != DriveType.Fixed || !drive.IsReady)
            {
                continue;
            }

            string volume = drive.Name.TrimEnd('\\');
            double? read = null;
            double? write = null;
            double? active = null;
            double? queue = null;

            if (_countersAvailable)
            {
                try
                {
                    if (!_diskCounters.TryGetValue(volume, out var counters))
                    {
                        counters = (
                            new PerformanceCounter("LogicalDisk", "Disk Read Bytes/sec", volume, readOnly: true),
                            new PerformanceCounter("LogicalDisk", "Disk Write Bytes/sec", volume, readOnly: true),
                            new PerformanceCounter("LogicalDisk", "% Disk Time", volume, readOnly: true),
                            new PerformanceCounter("LogicalDisk", "Current Disk Queue Length", volume, readOnly: true));
                        _diskCounters[volume] = counters;
                        counters.Read.NextValue();
                        counters.Write.NextValue();
                        counters.Active.NextValue();
                    }

                    read = counters.Read.NextValue();
                    write = counters.Write.NextValue();
                    active = Math.Clamp(counters.Active.NextValue(), 0, 100);
                    queue = counters.Queue.NextValue();
                }
                catch (Exception ex) when (ex is InvalidOperationException or Win32Exception)
                {
                    _logger.LogDebug(ex, "Disk counters for {Volume} are unreadable.", volume);
                }
            }

            string? label = null;
            try
            {
                label = string.IsNullOrWhiteSpace(drive.VolumeLabel) ? null : drive.VolumeLabel;
            }
            catch (IOException)
            {
                // A drive can disappear between the enumeration and this read.
            }

            samples.Add(new DiskSample(
                Volume: volume,
                Label: label,
                TotalBytes: drive.TotalSize,
                FreeBytes: drive.AvailableFreeSpace,
                ReadBytesPerSecond: read,
                WriteBytesPerSecond: write,
                ActiveTimePercent: active,
                QueueLength: queue,
                TemperatureCelsius: health.GetValueOrDefault(volume)?.TemperatureCelsius,
                // Windows' own verdict on the drive behind the volume; "unknown" when it has none.
                HealthStatus: health.GetValueOrDefault(volume)?.HealthStatus ?? "unknown"));
        }

        return samples;
    }

    /// <summary>
    /// The machine's network adapters, as a person would recognise them.
    ///
    /// Windows lists far more interfaces than a machine has: every NDIS filter bound to an
    /// adapter — QoS Packet Scheduler, the WFP MAC layer filters, the vendor's lightweight
    /// filter — appears as its own interface named after its parent. This PC reports five
    /// real adapters and thirty-seven of those, which is both useless to read and over the
    /// forty-two the protocol will accept in one sample.
    ///
    /// They are told apart by whether the interface has an address of its own. That is a
    /// property rather than a name pattern: a filter instance carries no unicast address,
    /// and every genuine adapter here has one even when it is unplugged. If that leaves
    /// nothing at all — a machine with nothing configured — the ones Windows says are up
    /// are reported instead, because an empty list would read as "no network" rather than
    /// "nothing addressed".
    /// </summary>
    private IReadOnlyList<NetworkSample> CollectNetworks(DateTimeOffset now)
    {
        var samples = new List<NetworkSample>();
        var fallback = new List<NetworkSample>();

        foreach (NetworkInterface adapter in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (adapter.NetworkInterfaceType == NetworkInterfaceType.Loopback ||
                adapter.NetworkInterfaceType == NetworkInterfaceType.Tunnel)
            {
                continue;
            }

            long received;
            long sent;
            try
            {
                IPv4InterfaceStatistics statistics = adapter.GetIPv4Statistics();
                received = statistics.BytesReceived;
                sent = statistics.BytesSent;
            }
            catch (NetworkInformationException)
            {
                continue;
            }

            double? receiveRate = null;
            double? sendRate = null;

            if (_networkPrevious.TryGetValue(adapter.Id, out var previous))
            {
                double elapsed = (now - previous.At).TotalSeconds;
                if (elapsed > 0.05)
                {
                    // Counters wrap on 32-bit adapters; a negative delta means a wrap or a
                    // reset, and inventing a huge spike would be worse than reporting nothing.
                    long receivedDelta = received - previous.Received;
                    long sentDelta = sent - previous.Sent;
                    receiveRate = receivedDelta >= 0 ? receivedDelta / elapsed : null;
                    sendRate = sentDelta >= 0 ? sentDelta / elapsed : null;
                }
            }

            _networkPrevious[adapter.Id] = (received, sent, now);

            var sample = new NetworkSample(
                AdapterId: adapter.Id,
                Name: adapter.Name,
                Kind: adapter.NetworkInterfaceType switch
                {
                    NetworkInterfaceType.Ethernet or NetworkInterfaceType.GigabitEthernet => "ethernet",
                    NetworkInterfaceType.Wireless80211 => "wifi",
                    NetworkInterfaceType.Loopback => "loopback",
                    _ => "other",
                },
                Up: adapter.OperationalStatus == OperationalStatus.Up,
                ReceiveBytesPerSecond: receiveRate,
                SendBytesPerSecond: sendRate,
                LinkSpeedBitsPerSecond: adapter.Speed > 0 ? adapter.Speed : null,
                // Wi-Fi signal strength needs the WLAN API; reported as unknown for now.
                SignalPercent: null);

            if (HasOwnAddress(adapter)) samples.Add(sample);
            else if (sample.Up) fallback.Add(sample);
        }

        List<NetworkSample> chosen = samples.Count > 0 ? samples : fallback;

        // Hard limit, last. Everything above is about reporting the useful adapters; this is
        // about never handing the cloud a message it is obliged to refuse. An unfamiliar
        // machine that still exceeds the cap loses the tail of a list rather than its link.
        if (chosen.Count > WolfProtocol.MaxNetworkSamples)
        {
            _logger.LogDebug(
                "Reporting {Kept} of {Total} network adapters; the protocol carries {Max}.",
                WolfProtocol.MaxNetworkSamples,
                chosen.Count,
                WolfProtocol.MaxNetworkSamples);

            // Connected ones first, so what survives the cut is what somebody would look at.
            chosen = chosen
                .OrderByDescending(network => network.Up)
                .Take(WolfProtocol.MaxNetworkSamples)
                .ToList();
        }

        return chosen;
    }

    /// <summary>
    /// Whether this interface has an IP address of its own.
    ///
    /// The test that separates a real adapter from an NDIS filter instance bound to one.
    /// A driver that refuses the query is treated as not having one: reporting an interface
    /// nothing can be said about is what fills the list up in the first place.
    /// </summary>
    private static bool HasOwnAddress(NetworkInterface adapter)
    {
        try
        {
            return adapter.GetIPProperties().UnicastAddresses.Count > 0;
        }
        catch (NetworkInformationException)
        {
            return false;
        }
        catch (PlatformNotSupportedException)
        {
            return false;
        }
    }

    private static BatterySample? CollectBattery()
    {
        if (!NativeMethods.GetSystemPowerStatus(out NativeMethods.SystemPowerStatus status))
        {
            return null;
        }

        // BatteryFlag 128 means "no system battery" — a desktop, where the honest answer is
        // that there is nothing to report rather than a battery at 0%.
        bool present = (status.BatteryFlag & 128) == 0;
        if (!present)
        {
            return new BatterySample(false, null, null, null, null);
        }

        double? charge = status.BatteryLifePercent == 255 ? null : status.BatteryLifePercent;
        bool? charging = status.ACLineStatus == 255 ? null : (status.BatteryFlag & 8) != 0;
        double? runtime = status.BatteryLifeTime < 0 ? null : status.BatteryLifeTime;

        return new BatterySample(true, charge, charging, runtime, null);
    }

    private AgentSelfSample CollectSelf(DateTimeOffset now)
    {
        double? cpuPercent = null;
        long? memory = null;

        try
        {
            _self.Refresh();
            TimeSpan cpu = _self.TotalProcessorTime;
            double elapsed = (now - _previousSelfAt).TotalSeconds;
            if (elapsed > 0.05)
            {
                double delta = (cpu - _previousSelfCpu).TotalSeconds;
                cpuPercent = Math.Clamp(delta / (elapsed * Environment.ProcessorCount) * 100, 0, 100);
            }

            _previousSelfCpu = cpu;
            _previousSelfAt = now;
            memory = _self.WorkingSet64;
        }
        catch (InvalidOperationException)
        {
            // The process object can go stale during shutdown.
        }

        return new AgentSelfSample(
            CpuPercent: cpuPercent,
            MemoryBytes: memory,
            NetworkBytesPerSecond: null,
            // Remote desktop capture and encoding land in a later milestone; reporting
            // "active" here would be a claim WOLF cannot currently back up.
            CaptureActive: false,
            EncoderActive: false);
    }

    public void Dispose()
    {
        _cpuTotal?.Dispose();
        _cpuQueue?.Dispose();
        _committedBytes?.Dispose();
        _cachedBytes?.Dispose();
        foreach ((_, PerformanceCounter counter) in _cpuPerCore)
        {
            counter.Dispose();
        }

        foreach (var counters in _diskCounters.Values)
        {
            counters.Read.Dispose();
            counters.Write.Dispose();
            counters.Active.Dispose();
            counters.Queue.Dispose();
        }

        _self.Dispose();
    }
}
