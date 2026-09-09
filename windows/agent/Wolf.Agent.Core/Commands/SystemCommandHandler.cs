using System.Management;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Win32;
using Wolf.Agent.Core.Ipc;
using Wolf.Agent.Core.Privileged;
using Wolf.Agent.Core.Native;
using Wolf.Agent.Core.Protocol;
using Wolf.Agent.Core.Sessions;
using Wolf.Agent.Core.Storage;
using Wolf.Agent.Core.Telemetry;

namespace Wolf.Agent.Core.Commands;

/// <summary>
/// Machine identity, capabilities, and session state.
///
/// The capability report is the contract the cloud relies on to decide what it may ask
/// this PC to do. Everything it claims must be something this build can genuinely deliver:
/// features that belong to a later milestone are reported as unavailable, so the cloud
/// refuses those commands up front instead of queueing work that would never run.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class SystemCommandHandler : ICommandHandler
{
    private readonly MachineInfoProvider _machine;
    private readonly WindowsSessionMonitor _sessions;
    private readonly TelemetryCollector _telemetry;
    private readonly Func<IReadOnlyList<string>> _supportedCommands;
    private readonly string _agentVersion;

    public SystemCommandHandler(
        MachineInfoProvider machine,
        WindowsSessionMonitor sessions,
        TelemetryCollector telemetry,
        Func<IReadOnlyList<string>> supportedCommands,
        string agentVersion)
    {
        _machine = machine;
        _sessions = sessions;
        _telemetry = telemetry;
        _supportedCommands = supportedCommands;
        _agentVersion = agentVersion;
    }

    public IReadOnlyList<string> SupportedTypes { get; } = new[]
    {
        "system.info",
        "system.capabilities",
        "system.telemetry-snapshot",
        "system.session-state",
    };

    public Task<CommandExecution> ExecuteAsync(CommandEnvelope envelope, CancellationToken cancellationToken)
    {
        _ = cancellationToken;
        return Task.FromResult(envelope.Type switch
        {
            "system.info" => CommandExecution.Success(_machine.Describe(_agentVersion)),
            "system.capabilities" => CommandExecution.Success(
                _machine.DescribeCapabilities(_supportedCommands(), _sessions.Query().State)),
            "system.session-state" => CommandExecution.Success(_sessions.Query()),
            "system.telemetry-snapshot" => CommandExecution.Success(new { sample = _telemetry.Collect() }),
            _ => CommandExecution.Failed("unsupported-command", $"Unhandled type {envelope.Type}."),
        });
    }
}

/// <summary>Reads static machine facts. Results are cached; hardware rarely changes mid-session.</summary>
[SupportedOSPlatform("windows")]
public sealed class MachineInfoProvider
{
    private readonly ILogger<MachineInfoProvider> _logger;
    private readonly SessionHostSupervisor _sessionHost;
    private readonly Func<bool> _killSwitchEngaged;
    private SystemInfoResult? _cached;

    public MachineInfoProvider(
        ILogger<MachineInfoProvider> logger,
        SessionHostSupervisor sessionHost,
        AgentStore store)
    {
        _logger = logger;
        _sessionHost = sessionHost;
        // Read at call time rather than captured: the switch can be thrown while the agent
        // is running, and a capability report that predates it would be wrong.
        _killSwitchEngaged = () => store.KillSwitchEngaged;
    }

    public SystemInfoResult Describe(string agentVersion, bool refresh = false)
    {
        if (_cached is not null && !refresh)
        {
            return _cached with { AgentVersion = agentVersion };
        }

        (int? cores, int? threads) = ReadProcessorCounts();

        _cached = new SystemInfoResult(
            Hostname: Environment.MachineName,
            OsName: ReadRegistryString(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion", "ProductName")
                    ?? RuntimeInformation.OSDescription,
            OsVersion: Environment.OSVersion.Version.ToString(),
            OsBuild: ReadWindowsBuild(),
            Architecture: RuntimeInformation.OSArchitecture.ToString(),
            CpuModel: ReadRegistryString(@"HARDWARE\DESCRIPTION\System\CentralProcessor\0", "ProcessorNameString"),
            CpuCores: cores,
            CpuThreads: threads ?? Environment.ProcessorCount,
            TotalMemoryBytes: ReadTotalMemory(),
            Gpus: ReadGpuNames(),
            BootedAt: DateTimeOffset.UtcNow.AddMilliseconds(-Environment.TickCount64).ToString("o"),
            AgentVersion: agentVersion);

        return _cached;
    }

    /// <summary>
    /// Report what this PC can actually do.
    ///
    /// Encoders and display count come from the session host, which enumerated them from
    /// Media Foundation and the live desktop. When no host is connected — nobody signed in,
    /// or the lock screen is up — the answer is an empty list rather than a stale one,
    /// because the cloud uses this to decide what it may offer.
    /// </summary>
    public SystemCapabilitiesResult DescribeCapabilities(
        IReadOnlyList<string> supportedCommands,
        string windowsSessionState)
    {
        SessionHostState host = _sessionHost.State;
        (bool available, string? reason) =
            RemoteDesktopAvailability.Evaluate(host, windowsSessionState, _killSwitchEngaged());

        IReadOnlyList<string> encoders = host.Connected
            ? host.Encoders.Where(encoder => encoder.Hardware).Select(encoder => encoder.Id).ToList()
            : Array.Empty<string>();

        return new SystemCapabilitiesResult(
            HardwareVideoEncoders: encoders,
            PreferredVideoCodec: ChoosePreferredCodec(host),
            // The session host counts the displays it can actually see. A service in
            // session 0 would always report zero, which is why this comes from the host.
            DisplayCount: host.Connected ? host.Displays.Count : ReadDisplayCount(),
            AudioCaptureAvailable: host.Connected && host.AudioCaptureAvailable,
            WakeOnLanCapable: false,

            // Asked at call time rather than assumed: the helper is a separate service and
            // can be stopped, and a PC that says it can do privileged work when it cannot is
            // one the cloud will offer operations that then fail.
            PrivilegedHelperAvailable: HelperClient.IsListening(),
            // Capturing the lock and sign-in screens requires the privileged helper running
            // in the Winlogon desktop. Until it exists, WOLF reports the limitation so the
            // UI shows a LOCKED state instead of a blank frame pretending to be the desktop.
            SecureDesktopCaptureAvailable: false,
            RemoteUnlockProvisioned: false,
            GpuVendors: ReadGpuVendors(),
            WindowsBuild: ReadWindowsBuild(),
            SupportedCommands: supportedCommands,
            RemoteDesktopAvailable: available,
            RemoteDesktopUnavailableReason: reason,
            VideoEncoders: host.Encoders.Select(encoder => encoder.Id).ToList());
    }

    /// <summary>
    /// The best codec this PC can encode in hardware.
    ///
    /// Only hardware encoders are offered as the preference: a software encoder works, and
    /// is kept as a fallback, but advertising it as preferred would have the cloud choose a
    /// codec that costs the machine's CPU to produce.
    /// </summary>
    private static string? ChoosePreferredCodec(SessionHostState host)
    {
        if (!host.Connected) return null;

        foreach (string codec in new[] { "av1", "h265", "h264" })
        {
            if (host.Encoders.Any(encoder => encoder.Hardware && encoder.Codec == codec))
            {
                return codec;
            }
        }

        // No hardware encoder at all: H.264 in software is still better than nothing, and
        // saying so lets the operator understand why the stream costs CPU.
        return host.Encoders.Any(encoder => encoder.Codec == "h264") ? "h264" : null;
    }

    private static string? ReadRegistryString(string keyPath, string valueName)
    {
        using RegistryKey? key = Registry.LocalMachine.OpenSubKey(keyPath);
        return key?.GetValue(valueName) as string;
    }

    private static string ReadWindowsBuild()
    {
        string? build = ReadRegistryString(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion", "CurrentBuildNumber");
        using RegistryKey? key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
        object? updateBuildRevision = key?.GetValue("UBR");

        return updateBuildRevision is int ubr && build is not null
            ? $"{build}.{ubr}"
            : build ?? Environment.OSVersion.Version.Build.ToString(System.Globalization.CultureInfo.InvariantCulture);
    }

    private static long? ReadTotalMemory()
    {
        var status = new NativeMethods.MemoryStatusEx
        {
            dwLength = (uint)Marshal.SizeOf<NativeMethods.MemoryStatusEx>(),
        };

        return NativeMethods.GlobalMemoryStatusEx(ref status) ? (long)status.ullTotalPhys : null;
    }

    private (int? Cores, int? Threads) ReadProcessorCounts()
    {
        try
        {
            using var searcher = new ManagementObjectSearcher(
                "SELECT NumberOfCores, NumberOfLogicalProcessors FROM Win32_Processor");
            using ManagementObjectCollection results = searcher.Get();

            var cores = 0;
            var threads = 0;
            foreach (ManagementBaseObject item in results)
            {
                using (item)
                {
                    cores += Convert.ToInt32(item["NumberOfCores"] ?? 0, System.Globalization.CultureInfo.InvariantCulture);
                    threads += Convert.ToInt32(item["NumberOfLogicalProcessors"] ?? 0, System.Globalization.CultureInfo.InvariantCulture);
                }
            }

            return (cores > 0 ? cores : null, threads > 0 ? threads : null);
        }
        catch (ManagementException ex)
        {
            _logger.LogDebug(ex, "Could not read processor counts from WMI.");
            return (null, null);
        }
    }

    private IReadOnlyList<string> ReadGpuNames() => QueryVideoControllers("Name");

    private IReadOnlyList<string> ReadGpuVendors() =>
        QueryVideoControllers("AdapterCompatibility").Distinct(StringComparer.OrdinalIgnoreCase).ToList();

    private IReadOnlyList<string> QueryVideoControllers(string property)
    {
        try
        {
            using var searcher = new ManagementObjectSearcher($"SELECT {property} FROM Win32_VideoController");
            using ManagementObjectCollection results = searcher.Get();

            var values = new List<string>();
            foreach (ManagementBaseObject item in results)
            {
                using (item)
                {
                    if (item[property] is string value && !string.IsNullOrWhiteSpace(value))
                    {
                        values.Add(value);
                    }
                }
            }

            return values;
        }
        catch (ManagementException ex)
        {
            _logger.LogDebug(ex, "Could not read video controllers from WMI.");
            return Array.Empty<string>();
        }
    }

    /// <summary>
    /// Attached monitors.
    ///
    /// Queried through WMI rather than the display APIs, because those enumerate the
    /// *calling session's* desktop and the agent runs in session 0, where it would always
    /// see zero. A machine whose WMI is unavailable reports 0, which the dashboard shows as
    /// "unknown" rather than as a claim about the hardware.
    /// </summary>
    private int ReadDisplayCount()
    {
        try
        {
            using var searcher = new ManagementObjectSearcher(
                "SELECT DeviceID FROM Win32_DesktopMonitor WHERE Availability = 3");
            using ManagementObjectCollection results = searcher.Get();
            return results.Count;
        }
        catch (ManagementException ex)
        {
            _logger.LogDebug(ex, "Could not count attached displays.");
            return 0;
        }
    }
}
