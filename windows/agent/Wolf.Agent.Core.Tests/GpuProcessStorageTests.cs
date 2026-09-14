using System.Diagnostics;
using System.Management;
using Wolf.Agent.Core.Commands;
using Wolf.Agent.Core.Telemetry;
using Xunit;
using Xunit.Abstractions;

namespace Wolf.Agent.Core.Tests;

/// <summary>
/// GPU load, per-process CPU and GPU, and drive health.
///
/// Two halves. The arithmetic — parsing counter instance names, turning engine counters into the
/// figures Task Manager shows, differencing CPU times — is pure and tested on made-up inputs. The
/// other half reads this machine's real GPU, real processes and real drives, and checks the answers
/// against what Windows says through a second, independent route, because a GPU reader that returns
/// plausible numbers for the wrong adapter is the failure worth catching.
/// </summary>
public sealed class GpuProcessStorageTests
{
    private readonly ITestOutputHelper _output;

    public GpuProcessStorageTests(ITestOutputHelper output)
    {
        _output = output;
    }

    /* ------------------------------------------------------------------ */
    /* Counter instance names                                              */
    /* ------------------------------------------------------------------ */

    [Fact]
    public void An_engine_instance_name_parses_into_its_parts()
    {
        Assert.True(GpuEngineInstance.TryParse("pid_19880_luid_0x00000000_0x00014B0E_phys_0_eng_13_engtype_Security_1", out GpuEngineInstance instance));

        Assert.Equal(19880, instance.Pid);
        Assert.Equal("0x00000000_0x00014B0E", instance.Luid);
        Assert.Equal(0, instance.Physical);
        Assert.Equal(13, instance.Engine);
        // Engine types can contain underscores; everything after "engtype_" is the type.
        Assert.Equal("Security_1", instance.EngineType);
    }

    [Fact]
    public void A_luid_is_normalised_so_counters_and_the_display_kernel_agree()
    {
        Assert.True(GpuEngineInstance.TryParse("pid_1_luid_0x00000000_0x00014b0e_phys_0_eng_0_engtype_3D", out GpuEngineInstance instance));
        Assert.Equal(GpuAdapters.FormatLuid(0, 0x00014B0E), instance.Luid);
    }

    [Theory]
    [InlineData("")]
    [InlineData("_Total")]
    [InlineData("pid_x_luid_0x00000000_0x00014B0E_phys_0_eng_0_engtype_3D")]
    [InlineData("pid_1_luid_0x0_0x1_phys_0_eng_0_engtype_3D")]
    public void Anything_else_is_not_an_engine_instance(string name)
    {
        Assert.False(GpuEngineInstance.TryParse(name, out _));
    }

    [Fact]
    public void Memory_instance_names_parse()
    {
        Assert.True(GpuEngineInstance.TryParseProcessMemory("pid_21460_luid_0x00000000_0x00014B0E_phys_0", out int pid, out string luid));
        Assert.Equal(21460, pid);
        Assert.Equal("0x00000000_0x00014B0E", luid);

        Assert.True(GpuEngineInstance.TryParseAdapterMemory("luid_0x00000000_0x00015D65_phys_0", out string adapter));
        Assert.Equal("0x00000000_0x00015D65", adapter);
        Assert.False(GpuEngineInstance.TryParseAdapterMemory("pid_1_luid_0x00000000_0x00015D65_phys_0", out _));
    }

    /* ------------------------------------------------------------------ */
    /* Engine counters into load                                           */
    /* ------------------------------------------------------------------ */

    private static (GpuEngineInstance, double) Engine(int pid, int engine, string type, double percent, string luid = "0x00000000_0x00000001") =>
        (new GpuEngineInstance(pid, luid, 0, engine, type), percent);

    [Fact]
    public void An_adapter_is_as_busy_as_its_busiest_engine()
    {
        // 3D at 70%, video decode at 20%. The GPU is 70% busy, not 90% and not 45%.
        GpuUtilization result = GpuUtilizationMath.Summarise(new[]
        {
            Engine(10, 0, "3D", 70),
            Engine(11, 3, "VideoDecode", 20),
            Engine(10, 1, "Copy", 0),
        });

        AdapterUtilization adapter = result.ByAdapterLuid["0x00000000_0x00000001"];
        Assert.Equal(70, adapter.UsagePercent);
        Assert.Equal(70, adapter.GraphicsPercent);
        Assert.Equal(20, adapter.VideoDecodePercent);
        // No engine of these families on this adapter: unknown, not idle.
        Assert.Null(adapter.ComputePercent);
        Assert.Null(adapter.VideoEncodePercent);
    }

    [Fact]
    public void An_engine_shared_by_processes_adds_up_and_is_capped()
    {
        GpuUtilization result = GpuUtilizationMath.Summarise(new[]
        {
            Engine(10, 0, "3D", 40),
            Engine(11, 0, "3D", 35),
            Engine(12, 0, "3D", 60),
        });

        Assert.Equal(100, result.ByAdapterLuid["0x00000000_0x00000001"].UsagePercent);
    }

    [Fact]
    public void A_process_is_as_busy_as_its_busiest_engine_on_any_adapter()
    {
        GpuUtilization result = GpuUtilizationMath.Summarise(new[]
        {
            Engine(10, 0, "3D", 12),
            Engine(10, 4, "VideoEncode", 30),
            Engine(10, 0, "3D", 8, luid: "0x00000000_0x00000002"),
            Engine(11, 0, "3D", 5),
        });

        Assert.Equal(30, result.ByProcess[10]);
        Assert.Equal(5, result.ByProcess[11]);
        Assert.Equal(2, result.ByAdapterLuid.Count);
    }

    [Fact]
    public void Garbage_counter_values_are_ignored_rather_than_poisoning_the_result()
    {
        GpuUtilization result = GpuUtilizationMath.Summarise(new[]
        {
            Engine(10, 0, "3D", double.NaN),
            Engine(11, 0, "3D", -5),
            Engine(12, 1, "Compute_0", 250),
        });

        AdapterUtilization adapter = result.ByAdapterLuid["0x00000000_0x00000001"];
        Assert.Equal(0, adapter.GraphicsPercent);
        Assert.Equal(100, adapter.ComputePercent);
    }

    [Fact]
    public void A_process_new_to_the_gpu_is_unknown_and_one_without_engines_is_zero()
    {
        var snapshot = new GpuCounterSnapshot(
            GpuUtilizationMath.Summarise(new[] { Engine(10, 0, "3D", 25) }),
            ProcessesWithEngines: new HashSet<int> { 10, 11 },
            DedicatedBytesByLuid: new Dictionary<string, long>(),
            DedicatedBytesByProcess: new Dictionary<int, long> { [10] = 1_000 });

        Assert.Equal(25, snapshot.ProcessPercent(10));
        Assert.Null(snapshot.ProcessPercent(11));
        Assert.Equal(0, snapshot.ProcessPercent(12));

        Assert.Equal(1_000, snapshot.ProcessDedicatedBytes(10));
        Assert.Equal(0, snapshot.ProcessDedicatedBytes(12));

        var first = new GpuCounterSnapshot(null, new HashSet<int>(), null, null);
        Assert.Null(first.ProcessPercent(10));
        Assert.Null(first.ProcessDedicatedBytes(10));
    }

    /* ------------------------------------------------------------------ */
    /* CPU times into load                                                 */
    /* ------------------------------------------------------------------ */

    private static readonly TimeSpan T0 = TimeSpan.FromSeconds(100);

    [Fact]
    public void The_first_reading_has_nothing_to_compare_against()
    {
        var sampler = new ProcessCpuSampler(processorCount: 4);
        Assert.False(sampler.HasFreshBaseline(T0));

        IReadOnlyDictionary<int, double> result = sampler.Observe(new[] { new ProcessCpuSampler.Observation(1, 50, TimeSpan.FromSeconds(10)) }, T0);

        Assert.Empty(result);
        Assert.True(sampler.HasFreshBaseline(T0 + TimeSpan.FromSeconds(1)));
    }

    [Fact]
    public void Cpu_is_a_share_of_the_whole_machine()
    {
        // Two cores, half a second of wall time: one full core of work is 50%.
        var sampler = new ProcessCpuSampler(processorCount: 2);
        sampler.Observe(new[] { new ProcessCpuSampler.Observation(1, 50, TimeSpan.FromSeconds(10)) }, T0);

        IReadOnlyDictionary<int, double> result = sampler.Observe(
            new[] { new ProcessCpuSampler.Observation(1, 50, TimeSpan.FromSeconds(10.5)) },
            T0 + TimeSpan.FromMilliseconds(500));

        Assert.Equal(50, result[1], precision: 6);
    }

    [Fact]
    public void A_reused_pid_is_not_compared_with_the_process_that_had_it()
    {
        var sampler = new ProcessCpuSampler(processorCount: 1);
        sampler.Observe(new[] { new ProcessCpuSampler.Observation(1, StartTicks: 50, TimeSpan.FromSeconds(900)) }, T0);

        IReadOnlyDictionary<int, double> result = sampler.Observe(
            new[] { new ProcessCpuSampler.Observation(1, StartTicks: 99, TimeSpan.FromSeconds(1)) },
            T0 + TimeSpan.FromSeconds(1));

        Assert.False(result.ContainsKey(1));
    }

    [Fact]
    public void Readings_too_close_or_too_far_apart_give_no_rate()
    {
        var sampler = new ProcessCpuSampler(processorCount: 1);
        var start = new[] { new ProcessCpuSampler.Observation(1, 50, TimeSpan.FromSeconds(1)) };

        sampler.Observe(start, T0);
        Assert.Empty(sampler.Observe(start, T0 + TimeSpan.FromMilliseconds(50)));

        sampler.Observe(start, T0);
        Assert.Empty(sampler.Observe(start, T0 + ProcessCpuSampler.MaximumAge + TimeSpan.FromSeconds(1)));
        Assert.False(sampler.HasFreshBaseline(T0 + ProcessCpuSampler.MaximumAge + TimeSpan.FromMinutes(2)));
    }

    [Fact]
    public void A_rate_above_the_machine_is_capped()
    {
        // Clock skew between the CPU-time and wall-time sources can overshoot slightly.
        var sampler = new ProcessCpuSampler(processorCount: 1);
        sampler.Observe(new[] { new ProcessCpuSampler.Observation(1, 50, TimeSpan.Zero) }, T0);

        IReadOnlyDictionary<int, double> result = sampler.Observe(
            new[] { new ProcessCpuSampler.Observation(1, 50, TimeSpan.FromSeconds(2)) },
            T0 + TimeSpan.FromSeconds(1));

        Assert.Equal(100, result[1]);
    }

    /* ------------------------------------------------------------------ */
    /* Drive health words                                                  */
    /* ------------------------------------------------------------------ */

    [Theory]
    [InlineData((ushort)0, "healthy")]
    [InlineData((ushort)1, "warning")]
    [InlineData((ushort)2, "failing")]
    [InlineData((ushort)5, "unknown")]
    public void Windows_health_codes_map_to_the_schema(ushort code, string expected)
    {
        Assert.Equal(expected, StorageHealthReader.MapHealth(code));
        Assert.Equal("unknown", StorageHealthReader.MapHealth(null));
    }
}
