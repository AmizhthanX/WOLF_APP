using System.Diagnostics;
using System.Management;
using System.Runtime.Versioning;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;
using Wolf.Agent.Core.Protocol;
using Wolf.Agent.Core.Telemetry;

namespace Wolf.Agent.Core.Commands;

/// <summary>Process information reported to the cloud, mirroring the protocol's shape.</summary>
public sealed record ProcessInfoPayload(
    [property: JsonPropertyName("pid")] int Pid,
    [property: JsonPropertyName("parentPid")] int? ParentPid,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("path")] string? Path,
    [property: JsonPropertyName("commandLine")] string? CommandLine,
    [property: JsonPropertyName("userName")] string? UserName,
    [property: JsonPropertyName("sessionId")] int? SessionId,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("startedAt")] string? StartedAt,
    [property: JsonPropertyName("cpuPercent")] double? CpuPercent,
    [property: JsonPropertyName("cpuTimeSeconds")] double? CpuTimeSeconds,
    [property: JsonPropertyName("workingSetBytes")] long? WorkingSetBytes,
    [property: JsonPropertyName("privateBytes")] long? PrivateBytes,
    [property: JsonPropertyName("gpuPercent")] double? GpuPercent,
    [property: JsonPropertyName("gpuMemoryBytes")] long? GpuMemoryBytes,
    [property: JsonPropertyName("threadCount")] int? ThreadCount,
    [property: JsonPropertyName("handleCount")] int? HandleCount,
    [property: JsonPropertyName("diskReadBytesPerSecond")] double? DiskReadBytesPerSecond,
    [property: JsonPropertyName("diskWriteBytesPerSecond")] double? DiskWriteBytesPerSecond,
    [property: JsonPropertyName("networkBytesPerSecond")] double? NetworkBytesPerSecond,
    [property: JsonPropertyName("priority")] string? Priority,
    [property: JsonPropertyName("publisher")] string? Publisher,
    [property: JsonPropertyName("signature")] string Signature,
    [property: JsonPropertyName("serviceNames")] IReadOnlyList<string> ServiceNames,
    [property: JsonPropertyName("protectedProcess")] bool ProtectedProcess);

/// <summary>
/// Process inspection and control.
///
/// The safety rule that shapes this class: a PID alone is never enough to act on. Windows
/// recycles PIDs quickly, so every mutating command carries the name the operator believed
/// they were acting on, and the agent refuses if the live process does not match. Without
/// that check, a confirmation dialog approved seconds ago could terminate an unrelated
/// process that happened to inherit the number.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class ProcessCommandHandler : ICommandHandler
{
    /// <summary>Processes WOLF will never terminate: killing any of these bluescreens Windows.</summary>
    private static readonly HashSet<string> CriticalProcesses = new(StringComparer.OrdinalIgnoreCase)
    {
        "System", "System Idle Process", "Registry", "smss", "csrss", "wininit",
        "services", "lsass", "winlogon", "Memory Compression",
    };

    private readonly ILogger<ProcessCommandHandler> _logger;

    public ProcessCommandHandler(ILogger<ProcessCommandHandler> logger)
    {
        _logger = logger;
    }

    public IReadOnlyList<string> SupportedTypes { get; } = new[]
    {
        "process.list",
        "process.tree",
        "process.details",
        "process.terminate",
        "process.set-priority",
    };

    public async Task<CommandExecution> ExecuteAsync(CommandEnvelope envelope, CancellationToken cancellationToken) =>
        envelope.Type switch
        {
            "process.list" => await ListAsync(envelope.Payload, cancellationToken),
            "process.tree" => Tree(envelope.Payload),
            "process.details" => Details(envelope.Payload),
            "process.terminate" => Terminate(envelope.Payload),
            "process.set-priority" => SetPriority(envelope.Payload),
            _ => CommandExecution.Failed("unsupported-command", $"Unhandled type {envelope.Type}."),
        };

    // -----------------------------------------------------------------------
    // Reads
    // -----------------------------------------------------------------------

    /// <summary>How long the first list after a quiet spell waits for its second CPU and GPU reading.</summary>
    public static readonly TimeSpan BaselineWait = TimeSpan.FromMilliseconds(500);

    private static readonly Stopwatch Clock = Stopwatch.StartNew();
    private readonly ProcessCpuSampler _cpuSampler = new(Environment.ProcessorCount);
    private readonly GpuCounterReader _gpuReader = new();
    private readonly object _gpuGate = new();

    private GpuCounterSnapshot? ReadGpu()
    {
        lock (_gpuGate)
        {
            return _gpuReader.Read();
        }
    }

    private static List<ProcessCpuSampler.Observation> ObserveCpu(Process[] processes)
    {
        var observations = new List<ProcessCpuSampler.Observation>(processes.Length);
        foreach (Process process in processes)
        {
            try
            {
                observations.Add(new ProcessCpuSampler.Observation(
                    process.Id,
                    process.StartTime.ToUniversalTime().Ticks,
                    process.TotalProcessorTime));
            }
            catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception or NotSupportedException)
            {
                // Exited, or protected from this account. Its CPU stays null.
            }
        }

        return observations;
    }

    private static void DisposeAll(Process[] processes)
    {
        foreach (Process process in processes)
        {
            process.Dispose();
        }
    }

    /// <summary>
    /// The process list, with CPU and GPU load measured over a real interval.
    ///
    /// Both are rates, so a list with no recent predecessor takes a reading, waits half a second and
    /// takes another. A list within thirty seconds of the last one reuses that reading as its baseline
    /// and answers at once, measuring the load since then.
    /// </summary>
    private async Task<CommandExecution> ListAsync(JsonElement payload, CancellationToken cancellationToken)
    {
        string? search = payload.TryGetProperty("search", out JsonElement searchElement) &&
                         searchElement.ValueKind == JsonValueKind.String
            ? searchElement.GetString()
            : null;
        int limit = payload.TryGetProperty("limit", out JsonElement limitElement) &&
                    limitElement.TryGetInt32(out int parsedLimit)
            ? parsedLimit
            : 500;

        if (!_cpuSampler.HasFreshBaseline(Clock.Elapsed))
        {
            Process[] baseline = Process.GetProcesses();
            try
            {
                _cpuSampler.Observe(ObserveCpu(baseline), Clock.Elapsed);
            }
            finally
            {
                DisposeAll(baseline);
            }

            ReadGpu();
            await Task.Delay(BaselineWait, cancellationToken);
        }

        Dictionary<int, int> parents = LoadParentMap();
        var infos = new List<ProcessInfoPayload>();
        int total = 0;

        Process[] all = Process.GetProcesses();
        try
        {
            IReadOnlyDictionary<int, double> cpu = _cpuSampler.Observe(ObserveCpu(all), Clock.Elapsed);
            GpuCounterSnapshot? gpu = ReadGpu();

            foreach (Process process in all)
            {
                string name;
                try
                {
                    name = process.ProcessName;
                }
                catch (InvalidOperationException)
                {
                    continue; // Exited between enumeration and read.
                }

                if (search is not null && !name.Contains(search, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                total++;
                if (infos.Count >= limit)
                {
                    continue;
                }

                infos.Add(Describe(process, name, parents, cpu, gpu));
            }
        }
        finally
        {
            DisposeAll(all);
        }

        return CommandExecution.Success(new
        {
            sampledAt = DateTimeOffset.UtcNow.ToString("o"),
            processes = infos,
            // Say so when the list was cut short, rather than implying it is complete.
            truncated = total > infos.Count,
            totalCount = total,
        });
    }

    private CommandExecution Tree(JsonElement payload)
    {
        int? rootPid = payload.TryGetProperty("rootPid", out JsonElement root) && root.TryGetInt32(out int parsed)
            ? parsed
            : null;

        Dictionary<int, int> parents = LoadParentMap();
        var nodes = new List<object>();
        foreach (Process process in Process.GetProcesses())
        {
            using (process)
            {
                try
                {
                    int? parentPid = parents.TryGetValue(process.Id, out int found) ? found : null;
                    if (rootPid is not null && process.Id != rootPid && parentPid != rootPid)
                    {
                        continue;
                    }

                    nodes.Add(new
                    {
                        pid = process.Id,
                        parentPid,
                        name = process.ProcessName,
                        cpuPercent = (double?)null,
                        workingSetBytes = (long?)process.WorkingSet64,
                    });
                }
                catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
                {
                    // Process exited or is inaccessible; skip it rather than failing the whole tree.
                }
            }
        }

        return CommandExecution.Success(new
        {
            sampledAt = DateTimeOffset.UtcNow.ToString("o"),
            nodes,
        });
    }

    private CommandExecution Details(JsonElement payload)
    {
        int pid = payload.GetProperty("pid").GetInt32();
        Process? process = TryOpen(pid);
        if (process is null)
        {
            return CommandExecution.Failed("not-found", $"No process with PID {pid} is running.");
        }

        using (process)
        {
            return CommandExecution.Success(new
            {
                sampledAt = DateTimeOffset.UtcNow.ToString("o"),
                process = Describe(process, process.ProcessName, LoadParentMap(), cpu: null, gpu: null),
            });
        }
    }

    // -----------------------------------------------------------------------
    // Mutations
    // -----------------------------------------------------------------------

    private CommandExecution Terminate(JsonElement payload)
    {
        int pid = payload.GetProperty("pid").GetInt32();
        string expectedName = payload.GetProperty("expectedName").GetString() ?? string.Empty;
        bool force = payload.TryGetProperty("force", out JsonElement forceElement) && forceElement.GetBoolean();
        bool includeChildren = payload.TryGetProperty("includeChildren", out JsonElement childrenElement) &&
                               childrenElement.GetBoolean();

        Process? process = TryOpen(pid);
        if (process is null)
        {
            return CommandExecution.Failed(
                "not-found",
                $"No process with PID {pid} is running. It may have already exited.");
        }

        using (process)
        {
            string actualName = process.ProcessName;

            // Windows reuses PIDs aggressively. If the process behind this PID is not the
            // one the operator confirmed, refusing is the only safe answer.
            if (!NamesMatch(actualName, expectedName))
            {
                _logger.LogWarning(
                    "Refused to terminate PID {Pid}: expected {Expected} but found {Actual}.",
                    pid,
                    expectedName,
                    actualName);

                return new CommandExecution(
                    null,
                    new CommandFailurePayload(
                        "target-changed",
                        $"PID {pid} is now \"{actualName}\", not \"{expectedName}\". Nothing was terminated.",
                        Limitation: false,
                        "Refresh the process list and try again."));
            }

            if (CriticalProcesses.Contains(actualName))
            {
                return CommandExecution.Limitation(
                    "blocked-by-policy",
                    $"\"{actualName}\" is a critical Windows process and cannot be terminated.",
                    "Terminating this process would crash Windows. Restart the PC instead.");
            }

            var childrenTerminated = 0;
            string method;

            if (includeChildren)
            {
                childrenTerminated = CountDescendants(pid, LoadParentMap());
                process.Kill(entireProcessTree: true);
                method = "tree-terminated";
            }
            else if (force)
            {
                process.Kill();
                method = "terminated";
            }
            else
            {
                // Ask first. A graceful close lets the application save; only if it refuses
                // within the grace period does WOLF terminate it.
                bool closed = process.CloseMainWindow() && process.WaitForExit(3000);
                if (closed)
                {
                    method = "graceful-close";
                }
                else
                {
                    process.Kill();
                    method = "terminated";
                }
            }

            process.WaitForExit(5000);

            return CommandExecution.Success(new
            {
                pid,
                name = actualName,
                method,
                childrenTerminated,
                endedAt = DateTimeOffset.UtcNow.ToString("o"),
            });
        }
    }

    private static CommandExecution SetPriority(JsonElement payload)
    {
        int pid = payload.GetProperty("pid").GetInt32();
        string expectedName = payload.GetProperty("expectedName").GetString() ?? string.Empty;
        string priority = payload.GetProperty("priority").GetString() ?? "normal";

        Process? process = TryOpen(pid);
        if (process is null)
        {
            return CommandExecution.Failed("not-found", $"No process with PID {pid} is running.");
        }

        using (process)
        {
            if (!NamesMatch(process.ProcessName, expectedName))
            {
                return new CommandExecution(
                    null,
                    new CommandFailurePayload(
                        "target-changed",
                        $"PID {pid} is now \"{process.ProcessName}\", not \"{expectedName}\". Nothing was changed.",
                        Limitation: false,
                        "Refresh the process list and try again."));
            }

            string? previous = TryReadPriority(process);
            process.PriorityClass = priority switch
            {
                "idle" => ProcessPriorityClass.Idle,
                "below-normal" => ProcessPriorityClass.BelowNormal,
                "normal" => ProcessPriorityClass.Normal,
                "above-normal" => ProcessPriorityClass.AboveNormal,
                "high" => ProcessPriorityClass.High,
                "realtime" => ProcessPriorityClass.RealTime,
                _ => ProcessPriorityClass.Normal,
            };

            return CommandExecution.Success(new
            {
                pid,
                name = process.ProcessName,
                previousPriority = previous,
                priority,
            });
        }
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    private static ProcessInfoPayload Describe(
        Process process,
        string name,
        IReadOnlyDictionary<int, int> parents,
        IReadOnlyDictionary<int, double>? cpu,
        GpuCounterSnapshot? gpu)
    {
        string? path = null;
        string? startedAt = null;
        int? sessionId = null;
        long? workingSet = null;
        long? privateBytes = null;
        int? threads = null;
        int? handles = null;
        double? cpuTime = null;
        string? priority = null;
        string status = "unknown";

        try
        {
            workingSet = process.WorkingSet64;
            privateBytes = process.PrivateMemorySize64;
            threads = process.Threads.Count;
            handles = process.HandleCount;
            sessionId = process.SessionId;
            status = process.Responding ? "running" : "not-responding";
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            // A protected or exited process; the fields stay null rather than guessed.
        }

        try
        {
            startedAt = process.StartTime.ToUniversalTime().ToString("o");
            cpuTime = process.TotalProcessorTime.TotalSeconds;
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
        }

        try
        {
            path = process.MainModule?.FileName;
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception or NotSupportedException)
        {
            // Reading the image path of a process owned by another account requires rights
            // a least-privilege agent does not have. Null is the honest answer.
        }

        priority = TryReadPriority(process);

        return new ProcessInfoPayload(
            Pid: process.Id,
            ParentPid: parents.TryGetValue(process.Id, out int parentPid) ? parentPid : null,
            Name: name,
            Path: path,
            CommandLine: null,
            UserName: null,
            SessionId: sessionId,
            Status: status,
            StartedAt: startedAt,
            CpuPercent: cpu is not null && cpu.TryGetValue(process.Id, out double cpuPercent) ? Math.Round(cpuPercent, 2) : null,
            CpuTimeSeconds: cpuTime,
            WorkingSetBytes: workingSet,
            PrivateBytes: privateBytes,
            GpuPercent: gpu?.ProcessPercent(process.Id) is double gpuPercent ? Math.Round(gpuPercent, 2) : null,
            GpuMemoryBytes: gpu?.ProcessDedicatedBytes(process.Id),
            ThreadCount: threads,
            HandleCount: handles,
            DiskReadBytesPerSecond: null,
            DiskWriteBytesPerSecond: null,
            NetworkBytesPerSecond: null,
            Priority: priority,
            Publisher: null,
            Signature: "unknown",
            ServiceNames: Array.Empty<string>(),
            ProtectedProcess: CriticalProcesses.Contains(name));
    }

    private static string? TryReadPriority(Process process)
    {
        try
        {
            return process.PriorityClass switch
            {
                ProcessPriorityClass.Idle => "idle",
                ProcessPriorityClass.BelowNormal => "below-normal",
                ProcessPriorityClass.Normal => "normal",
                ProcessPriorityClass.AboveNormal => "above-normal",
                ProcessPriorityClass.High => "high",
                ProcessPriorityClass.RealTime => "realtime",
                _ => null,
            };
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            return null;
        }
    }

    private static Process? TryOpen(int pid)
    {
        try
        {
            return Process.GetProcessById(pid);
        }
        catch (ArgumentException)
        {
            return null;
        }
    }

    /// <summary>Compare with and without the .exe suffix; both forms reach the agent.</summary>
    private static bool NamesMatch(string actual, string expected)
    {
        string Normalize(string value) =>
            value.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? value[..^4] : value;

        return string.Equals(Normalize(actual), Normalize(expected), StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Child-to-parent PID map for the whole machine.
    ///
    /// Read once per command rather than per process: a WMI query costs real time, and the
    /// alternative (a native NtQueryInformationProcess call per process) trades an
    /// undocumented API for a saving the agent does not need.
    /// </summary>
    private Dictionary<int, int> LoadParentMap()
    {
        var map = new Dictionary<int, int>();
        try
        {
            using var searcher = new ManagementObjectSearcher(
                "SELECT ProcessId, ParentProcessId FROM Win32_Process");
            using ManagementObjectCollection results = searcher.Get();

            foreach (ManagementBaseObject item in results)
            {
                using (item)
                {
                    if (item["ProcessId"] is null || item["ParentProcessId"] is null)
                    {
                        continue;
                    }

                    map[Convert.ToInt32(item["ProcessId"], System.Globalization.CultureInfo.InvariantCulture)] =
                        Convert.ToInt32(item["ParentProcessId"], System.Globalization.CultureInfo.InvariantCulture);
                }
            }
        }
        catch (ManagementException ex)
        {
            // WMI can be disabled or broken. Parent relationships are then reported as
            // unknown rather than invented.
            _logger.LogDebug(ex, "Could not read process parent relationships from WMI.");
        }

        return map;
    }

    private static int CountDescendants(int pid, IReadOnlyDictionary<int, int> parents)
    {
        var queue = new Queue<int>();
        queue.Enqueue(pid);
        var seen = new HashSet<int> { pid };
        var count = 0;

        while (queue.Count > 0)
        {
            int current = queue.Dequeue();
            foreach ((int child, int parent) in parents)
            {
                if (parent == current && seen.Add(child))
                {
                    count++;
                    queue.Enqueue(child);
                }
            }
        }

        return count;
    }
}
