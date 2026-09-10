using System.Reflection;
using System.Runtime.Versioning;
using System.Text.Json;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Wolf.Agent.Core.Cloud;
using Wolf.Agent.Core.Commands;
using Wolf.Agent.Core.Identity;
using Wolf.Agent.Core.Ipc;
using Wolf.Agent.Core.Protocol;
using Wolf.Agent.Core.Sessions;
using Wolf.Agent.Core.Storage;
using Wolf.Agent.Core.Telemetry;

namespace Wolf.Agent.Core;

/// <summary>
/// The agent's main loop.
///
/// Two independent jobs run side by side: sampling the machine, which never stops, and
/// talking to the cloud, which reconnects as needed. Keeping them separate is what lets
/// WOLF stay useful during an outage — the sampler fills the local store, and the link
/// drains it when it comes back.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class AgentWorker : BackgroundService
{
    /// <summary>Environment variable the installer uses to pass the one-time enrollment token.</summary>
    public const string EnrollmentTokenVariable = "WOLF_ENROLLMENT_TOKEN";

    private readonly AgentOptions _options;
    private readonly AgentStore _store;
    private readonly PcIdentityStore _identityStore;
    private readonly EnrollmentClient _enrollment;
    private readonly TelemetryCollector _telemetry;
    private readonly WindowsSessionMonitor _sessions;
    private readonly MachineInfoProvider _machine;
    private readonly CommandRouter _router;
    private readonly SessionHostSupervisor _sessionHost;
    private readonly SecureDesktopWatcher _secureDesktop;
    private readonly ILoggerFactory _loggerFactory;
    private readonly ILogger<AgentWorker> _logger;

    public static string AgentVersion =>
        Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "0.0.0";

    public AgentWorker(
        IOptions<AgentOptions> options,
        AgentStore store,
        PcIdentityStore identityStore,
        EnrollmentClient enrollment,
        TelemetryCollector telemetry,
        WindowsSessionMonitor sessions,
        MachineInfoProvider machine,
        CommandRouter router,
        SessionHostSupervisor sessionHost,
        SecureDesktopWatcher secureDesktop,
        ILoggerFactory loggerFactory,
        ILogger<AgentWorker> logger)
    {
        _options = options.Value;
        _store = store;
        _identityStore = identityStore;
        _enrollment = enrollment;
        _telemetry = telemetry;
        _sessions = sessions;
        _machine = machine;
        _router = router;
        _sessionHost = sessionHost;
        _secureDesktop = secureDesktop;
        _loggerFactory = loggerFactory;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("WOLF agent {Version} starting on {Machine}.", AgentVersion, Environment.MachineName);
        _store.RecordLocalAudit("agent.start", "success", new { version = AgentVersion });

        // The session host is supervised independently of the cloud link. Someone signing
        // in should be reflected in the PC capabilities whether or not the cloud is
        // reachable at that moment.
        _sessionHost.Start();

        // Watches the desktop the session host reports and starts a host on the secure one
        // when it takes the input. Does nothing at all on a PC where that is not possible.
        _secureDesktop.Start();

        // Sampling starts before enrollment: a PC that is waiting to be enrolled still has
        // a local history worth keeping, and the operator can see the agent is alive.
        Task sampler = SampleLoopAsync(stoppingToken);

        PcIdentity? identity = await ResolveIdentityAsync(stoppingToken).ConfigureAwait(false);
        if (identity is null)
        {
            _logger.LogWarning(
                "This PC is not enrolled. Local monitoring continues; set {Variable} and restart the " +
                "service, or run enrollment from the WOLF Control Panel.",
                EnrollmentTokenVariable);
            await sampler.ConfigureAwait(false);
            return;
        }

        var link = new CloudLink(
            _options,
            identity,
            _router,
            _telemetry,
            _store,
            _sessions,
            _machine,
            _sessionHost,
            AgentVersion,
            _loggerFactory.CreateLogger<CloudLink>());

        try
        {
            await Task.WhenAll(sampler, link.RunAsync(stoppingToken)).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // Normal shutdown.
        }
        finally
        {
            await _sessionHost.DisposeAsync().ConfigureAwait(false);
            _store.RecordLocalAudit("agent.stop", "success");
            _logger.LogInformation("WOLF agent stopped.");
        }
    }

    /// <summary>
    /// Load the enrolled identity, or enrol once if the installer supplied a token.
    ///
    /// A failed enrollment is not retried in a loop: the token is single-use, so retrying
    /// would only burn attempts. The agent keeps monitoring locally and waits for an
    /// operator.
    /// </summary>
    private async Task<PcIdentity?> ResolveIdentityAsync(CancellationToken cancellationToken)
    {
        PcIdentity? identity = _identityStore.Load();
        if (identity is not null)
        {
            _logger.LogInformation("Loaded the enrolled identity for PC {PcId}.", identity.PcId);
            return identity;
        }

        string? token = Environment.GetEnvironmentVariable(EnrollmentTokenVariable);
        if (string.IsNullOrWhiteSpace(token))
        {
            return null;
        }

        try
        {
            identity = await _enrollment
                .EnrollAsync(_options, _identityStore, token, AgentVersion, cancellationToken)
                .ConfigureAwait(false);

            _store.RecordLocalAudit("agent.enroll", "success", new { identity.PcId });
            _logger.LogInformation("Enrolled as PC {PcId}.", identity.PcId);

            // The token is single-use and must not linger in the service environment.
            Environment.SetEnvironmentVariable(EnrollmentTokenVariable, null);
            return identity;
        }
        catch (EnrollmentException ex)
        {
            _store.RecordLocalAudit("agent.enroll", "failure", new { reason = ex.Message });
            _logger.LogError("Enrollment failed: {Problem} {Action}", ex.Message, ex.RecommendedAction);
            return null;
        }
    }

    /// <summary>
    /// Sample the machine on a fixed cadence and buffer the result locally.
    ///
    /// The buffer is bounded, so a long outage costs a fixed amount of disk rather than
    /// growing without limit.
    /// </summary>
    private async Task SampleLoopAsync(CancellationToken cancellationToken)
    {
        var interval = TimeSpan.FromSeconds(Math.Max(1, _options.TelemetryIntervalSeconds));

        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                TelemetrySample sample = _telemetry.Collect();
                _store.EnqueueTelemetry(
                    sample.SampledAt,
                    JsonSerializer.Serialize(sample, WolfProtocol.Json),
                    _options.OfflineSampleBufferLimit);
            }
            catch (Exception ex)
            {
                // Sampling must never take the agent down. A failed sample is logged and the
                // loop continues with the next one.
                _logger.LogError(ex, "Telemetry sampling failed.");
            }

            try
            {
                await Task.Delay(interval, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }
}
