using System.Diagnostics;
using System.Management;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Wolf.Agent.Core.Commands;
using Wolf.Agent.Core.Protocol;
using Wolf.Agent.Core.Telemetry;
using Xunit;
using Xunit.Abstractions;

namespace Wolf.Agent.Core.Tests;

/// <summary>
/// The GPU, process and drive readers against this machine's real hardware.
///
/// Each answer is checked against Windows through a second, independent route where one exists —
/// WMI's list of display controllers for the adapter list, the counters' own adapter instances for
/// the LUIDs — because the failure worth catching is a reader that returns plausible numbers for the
/// wrong adapter, not one that throws.
///
/// On a machine with no GPU at all (a CI runner) the adapter tests still assert something: that WMI
/// agrees there is no PCI display controller.
/// </summary>
public sealed class GpuProcessStorageHardwareTests
{
    private readonly ITestOutputHelper _output;

    public GpuProcessStorageHardwareTests(ITestOutputHelper output)
    {
        _output = output;
    }

    private static List<(string Name, string PnpId)> PciDisplayControllers()
    {
        var controllers = new List<(string, string)>();
        using var searcher = new ManagementObjectSearcher("SELECT Name, PNPDeviceID FROM Win32_VideoController");
        foreach (ManagementBaseObject controller in searcher.Get())
        {
            using (controller)
            {
                if (controller["PNPDeviceID"] is string pnp && pnp.StartsWith(@"PCI\", StringComparison.OrdinalIgnoreCase))
                {
                    controllers.Add(((string?)controller["Name"] ?? string.Empty, pnp));
                }
            }
        }

        return controllers;
    }

    [Fact]
    public void Every_pci_display_controller_is_enumerated_once_by_name_with_its_memory()
    {
        IReadOnlyList<GpuAdapter> adapters = GpuAdapters.Enumerate();
        List<(string Name, string PnpId)> controllers = PciDisplayControllers();

        foreach (GpuAdapter adapter in adapters)
        {
            _output.WriteLine($"{adapter.AdapterId} {adapter.Luid} '{adapter.Name}' vram={adapter.DedicatedVideoMemoryBytes} temp={adapter.TemperatureCelsius}");
        }

        foreach ((string name, string pnp) in controllers)
        {
            _output.WriteLine($"WMI: '{name}' {pnp}");
        }

        // Software renderers and virtual displays (this machine has a Parsec virtual adapter) are
        // left out; every real PCI GPU is in, once.
        Assert.Equal(controllers.Count, adapters.Count(adapter => adapter.AdapterId.StartsWith("pci-", StringComparison.Ordinal)));
        Assert.Equal(adapters.Count, adapters.Select(adapter => adapter.AdapterId).Distinct().Count());

        foreach ((string name, _) in controllers)
        {
            Assert.Contains(adapters, adapter => adapter.Name == name);
        }

        Assert.All(adapters, adapter => Assert.True(adapter.DedicatedVideoMemoryBytes > 0, $"{adapter.Name} reported no dedicated memory"));
    }

    [Fact]
    public async Task The_gpu_counters_describe_the_adapters_the_display_kernel_lists()
    {
        IReadOnlyList<GpuAdapter> adapters = GpuAdapters.Enumerate();
        if (adapters.Count == 0)
        {
            Assert.Empty(PciDisplayControllers());
            return;
        }

        var reader = new GpuCounterReader();
        GpuCounterSnapshot? first = reader.Read();
        Assert.NotNull(first);
        // A rate needs two readings; the first must not pretend otherwise.
        Assert.Null(first!.Utilization);

        await Task.Delay(600);
        GpuCounterSnapshot? second = reader.Read();
        Assert.NotNull(second?.Utilization);
        Assert.NotNull(second!.DedicatedBytesByLuid);

        foreach ((string luid, AdapterUtilization load) in second.Utilization!.ByAdapterLuid)
        {
            _output.WriteLine($"counters {luid}: usage={load.UsagePercent:F1} 3d={load.GraphicsPercent} compute={load.ComputePercent} enc={load.VideoEncodePercent} dec={load.VideoDecodePercent} vram={second.DedicatedBytesByLuid!.GetValueOrDefault(luid)}");
        }

        // The LUID is the only thing joining a load figure to a named GPU. If the two sources format
        // it differently every GPU silently reports "unknown".
        foreach (GpuAdapter adapter in adapters)
        {
            Assert.True(second.DedicatedBytesByLuid!.ContainsKey(adapter.Luid), $"no memory counter for {adapter.Name} ({adapter.Luid})");
        }

        Assert.Contains(adapters, adapter => second.Utilization.ByAdapterLuid.ContainsKey(adapter.Luid));
    }

    [Fact]
    public void The_collector_reports_each_gpu_with_load_and_memory_from_its_second_sample()
    {
        IReadOnlyList<GpuAdapter> adapters = GpuAdapters.Enumerate();
        using var collector = new TelemetryCollector(NullLogger<TelemetryCollector>.Instance);

        collector.Collect();
        Thread.Sleep(600);
        TelemetrySample sample = collector.Collect();

        Assert.Equal(Math.Min(8, adapters.Count), sample.Gpus.Count);
        if (adapters.Count == 0)
        {
            return;
        }

        foreach (GpuSample gpu in sample.Gpus)
        {
            _output.WriteLine($"{gpu.AdapterId} '{gpu.Name}' usage={gpu.UsagePercent} vram={gpu.VramUsedBytes}/{gpu.VramTotalBytes} temp={gpu.TemperatureCelsius}");
            Assert.NotNull(gpu.VramTotalBytes);
            Assert.NotNull(gpu.VramUsedBytes);
            Assert.True(gpu.VramUsedBytes <= gpu.VramTotalBytes, "used memory above the total means the wrong adapter's counter");
            Assert.InRange(gpu.UsagePercent ?? 0, 0, 100);
            // Never invented: clocks, fan and watts have no source here.
            Assert.Null(gpu.CoreClockMhz);
            Assert.Null(gpu.FanPercent);
            Assert.Null(gpu.PowerWatts);
        }

        Assert.Contains(sample.Gpus, gpu => gpu.UsagePercent is not null);
    }

    [Fact]
    public void The_system_volume_carries_windows_own_health_verdict()
    {
        var reader = new StorageHealthReader();
        IReadOnlyDictionary<string, VolumeHealth> health = reader.Read(DateTimeOffset.UtcNow);

        foreach ((string volume, VolumeHealth entry) in health)
        {
            _output.WriteLine($"{volume}: {entry.HealthStatus} {entry.TemperatureCelsius}");
        }

        _output.WriteLine($"temperature: {reader.TemperatureUnavailableReason ?? "available"}");

        string system = Path.GetPathRoot(Environment.SystemDirectory)!.TrimEnd('\\');
        Assert.True(health.TryGetValue(system, out VolumeHealth? systemHealth), $"no health for {system}");
        Assert.Contains(systemHealth!.HealthStatus, new[] { "healthy", "warning", "failing" });

        // Cached: a second read inside the refresh interval is the same answer, not a new query.
        Assert.Same(health, reader.Read(DateTimeOffset.UtcNow.AddSeconds(5)));
    }

    private static CommandEnvelope ListEnvelope(string? search, int limit)
    {
        string payloadJson = search is null
            ? $$"""{"limit": {{limit}}}"""
            : $$"""{"search": {{JsonSerializer.Serialize(search)}}, "limit": {{limit}}}""";
        using JsonDocument payload = JsonDocument.Parse(payloadJson);
        using JsonDocument authorization = JsonDocument.Parse("{}");

        return new CommandEnvelope(
            CommandId: Guid.NewGuid().ToString("N"),
            PcId: "01J9ZQK7T0000000000000000A",
            RequestId: Guid.NewGuid().ToString("N"),
            IssuedAt: DateTimeOffset.UtcNow,
            ExpiresAt: DateTimeOffset.UtcNow.AddMinutes(1),
            IdempotencyKey: Guid.NewGuid().ToString("N"),
            Type: "process.list",
            Payload: payload.RootElement.Clone(),
            Authorization: authorization.RootElement.Clone());
    }

    [Fact]
    public async Task The_process_list_measures_a_busy_process_over_a_real_interval()
    {
        var handler = new ProcessCommandHandler(NullLogger<ProcessCommandHandler>.Instance);
        using Process self = Process.GetCurrentProcess();

        using var stop = new CancellationTokenSource();
        var spinner = new Thread(() =>
        {
            double x = 0;
            while (!stop.IsCancellationRequested)
            {
                x = Math.Sqrt(x + 12345.678);
            }
        })
        { IsBackground = true };
        spinner.Start();

        JsonElement processes;
        var timer = Stopwatch.StartNew();
        try
        {
            CommandExecution result = await handler.ExecuteAsync(ListEnvelope(self.ProcessName, 50), CancellationToken.None);
            timer.Stop();
            Assert.Null(result.Failure);
            processes = JsonSerializer.SerializeToElement(result.Result).GetProperty("processes");
        }
        finally
        {
            stop.Cancel();
            spinner.Join();
        }

        // The first list had no baseline, so it waited for a second reading rather than guessing.
        Assert.True(timer.Elapsed >= ProcessCommandHandler.BaselineWait - TimeSpan.FromMilliseconds(50), $"took {timer.ElapsedMilliseconds} ms");

        JsonElement mine = processes.EnumerateArray().Single(process => process.GetProperty("pid").GetInt32() == Environment.ProcessId);
        double cpu = mine.GetProperty("cpuPercent").GetDouble();
        _output.WriteLine($"test host cpu {cpu:F2}% of {Environment.ProcessorCount} logical processors");

        // One thread spinning is one logical processor's worth; allow for scheduling.
        Assert.InRange(cpu, 0.5 * 100.0 / Environment.ProcessorCount, 100);
    }

    [Fact]
    public async Task The_process_list_attributes_gpu_memory_to_the_processes_that_hold_it()
    {
        if (GpuAdapters.Enumerate().Count == 0)
        {
            Assert.Empty(PciDisplayControllers());
            return;
        }

        var handler = new ProcessCommandHandler(NullLogger<ProcessCommandHandler>.Instance);
        CommandExecution result = await handler.ExecuteAsync(ListEnvelope(search: null, limit: 1000), CancellationToken.None);
        Assert.Null(result.Failure);

        List<JsonElement> processes = JsonSerializer.SerializeToElement(result.Result).GetProperty("processes").EnumerateArray().ToList();
        List<JsonElement> holders = processes
            .Where(process => process.GetProperty("gpuMemoryBytes").ValueKind == JsonValueKind.Number &&
                              process.GetProperty("gpuMemoryBytes").GetInt64() > 0)
            .ToList();

        foreach (JsonElement holder in holders.OrderByDescending(process => process.GetProperty("gpuMemoryBytes").GetInt64()).Take(5))
        {
            _output.WriteLine($"{holder.GetProperty("name").GetString()} gpu={holder.GetProperty("gpuPercent")} mem={holder.GetProperty("gpuMemoryBytes").GetInt64()}");
        }

        // A machine with a GPU and a desktop has at least the compositor holding video memory.
        Assert.NotEmpty(holders);
        Assert.All(processes, process =>
        {
            JsonElement gpu = process.GetProperty("gpuPercent");
            if (gpu.ValueKind == JsonValueKind.Number)
            {
                Assert.InRange(gpu.GetDouble(), 0, 100);
            }
        });
    }
}
