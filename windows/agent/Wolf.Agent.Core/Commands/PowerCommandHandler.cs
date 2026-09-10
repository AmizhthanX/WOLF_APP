using System.Globalization;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Wolf.Agent.Core.Ipc;
using Wolf.Agent.Core.Native;
using Wolf.Agent.Core.Protocol;
using Wolf.Agent.Core.Storage;

namespace Wolf.Agent.Core.Commands;

/// <summary>
/// Power control.
///
/// Two things are deliberately explicit here. First, a scheduled action stores an absolute
/// instant and is discarded if that instant has already passed when the agent restarts — a
/// shutdown must never fire simply because the machine came back online. Second, actions
/// this build genuinely cannot perform from a Windows service (locking the console session)
/// return a clearly labelled platform limitation instead of a false success.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class PowerCommandHandler : ICommandHandler, IDisposable
{
    private readonly AgentStore _store;
    private readonly SessionHostSupervisor _sessionHost;
    private readonly ILogger<PowerCommandHandler> _logger;
    private readonly Timer _scheduler;
    private readonly object _gate = new();

    public PowerCommandHandler(
        AgentStore store,
        SessionHostSupervisor sessionHost,
        ILogger<PowerCommandHandler> logger)
    {
        _store = store;
        _sessionHost = sessionHost;
        _logger = logger;

        DiscardOverdueActions();
        _scheduler = new Timer(_ => RunDueActions(), null, TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(5));
    }

    public IReadOnlyList<string> SupportedTypes { get; } = new[]
    {
        "power.action",
        "power.schedule",
        "power.cancel",
        "power.pending",
    };

    public async Task<CommandExecution> ExecuteAsync(
        CommandEnvelope envelope,
        CancellationToken cancellationToken)
    {
        _ = cancellationToken;

        return envelope.Type switch
        {
            // Locking is the one action that has to be carried out by another process, so
            // this is the only branch that waits on anything.
            "power.action" => await ActAsync(envelope).ConfigureAwait(false),
            "power.schedule" => Schedule(envelope),
            "power.cancel" => Cancel(envelope.Payload),
            "power.pending" => Pending(),
            _ => CommandExecution.Failed("unsupported-command", $"Unhandled type {envelope.Type}."),
        };
    }

    // -----------------------------------------------------------------------
    // Commands
    // -----------------------------------------------------------------------

    private async Task<CommandExecution> ActAsync(CommandEnvelope envelope)
    {
        string action = envelope.Payload.GetProperty("action").GetString() ?? string.Empty;
        bool force = envelope.Payload.TryGetProperty("force", out JsonElement forceElement) &&
                     forceElement.GetBoolean();
        int delaySeconds = envelope.Payload.TryGetProperty("delaySeconds", out JsonElement delayElement) &&
                           delayElement.TryGetInt32(out int parsedDelay)
            ? parsedDelay
            : 0;
        string? reason = envelope.Payload.TryGetProperty("reason", out JsonElement reasonElement) &&
                         reasonElement.ValueKind == JsonValueKind.String
            ? reasonElement.GetString()
            : null;

        DateTimeOffset runAt = DateTimeOffset.UtcNow.AddSeconds(delaySeconds);

        // Shutdown and restart carry their own countdown in Windows, which shows the signed-in
        // user a warning and lets a local operator abort. That is better than WOLF holding a
        // silent timer, so the delay is handed to Windows rather than kept here.
        if (action is "shutdown" or "restart")
        {
            CommandExecution outcome = InitiateShutdown(action, delaySeconds, force, reason);
            if (outcome.Failure is not null)
            {
                return outcome;
            }

            string pendingId = $"win-{action}";
            if (delaySeconds > 0)
            {
                _store.SavePendingPowerAction(new PendingPowerAction(
                    pendingId, action, runAt, force, envelope.Authorization.TryGetProperty("userId", out JsonElement user)
                        ? user.GetString()
                        : null, reason));
            }

            return CommandExecution.Success(new
            {
                action,
                pendingActionId = delaySeconds > 0 ? pendingId : null,
                runAt = runAt.ToString("o"),
                completed = delaySeconds == 0,
            });
        }

        if (delaySeconds > 0)
        {
            string pendingId = Guid.NewGuid().ToString("N")[..16];
            _store.SavePendingPowerAction(new PendingPowerAction(pendingId, action, runAt, force, null, reason));
            return CommandExecution.Success(new
            {
                action,
                pendingActionId = pendingId,
                runAt = runAt.ToString("o"),
                completed = false,
            });
        }

        CommandExecution immediate = await PerformAsync(action, force).ConfigureAwait(false);
        if (immediate.Failure is not null)
        {
            return immediate;
        }

        return CommandExecution.Success(new
        {
            action,
            pendingActionId = (string?)null,
            runAt = runAt.ToString("o"),
            // Windows accepts the request; the transition itself completes after this returns.
            completed = action is "sign-out" or "sleep" or "hibernate",
        });
    }

    private CommandExecution Schedule(CommandEnvelope envelope)
    {
        string action = envelope.Payload.GetProperty("action").GetString() ?? string.Empty;
        string runAtRaw = envelope.Payload.GetProperty("runAt").GetString() ?? string.Empty;
        bool force = envelope.Payload.TryGetProperty("force", out JsonElement forceElement) &&
                     forceElement.GetBoolean();
        string? reason = envelope.Payload.TryGetProperty("reason", out JsonElement reasonElement) &&
                         reasonElement.ValueKind == JsonValueKind.String
            ? reasonElement.GetString()
            : null;

        if (!DateTimeOffset.TryParse(runAtRaw, CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out DateTimeOffset runAt))
        {
            return CommandExecution.Failed("invalid-payload", "The scheduled time could not be parsed.");
        }

        if (runAt <= DateTimeOffset.UtcNow)
        {
            return CommandExecution.Failed(
                "invalid-payload",
                "The scheduled time is in the past.",
                "Pick a time in the future.");
        }

        string pendingId = Guid.NewGuid().ToString("N")[..16];
        _store.SavePendingPowerAction(new PendingPowerAction(pendingId, action, runAt, force, null, reason));
        _store.RecordLocalAudit("power.schedule", "success", new { action, runAt = runAt.ToString("o") });

        _logger.LogInformation("Scheduled {Action} for {RunAt}.", action, runAt);

        return CommandExecution.Success(new
        {
            pendingActionId = pendingId,
            action,
            runAt = runAt.ToString("o"),
        });
    }

    private CommandExecution Cancel(JsonElement payload)
    {
        string pendingId = payload.GetProperty("pendingActionId").GetString() ?? string.Empty;

        // A Windows-owned countdown is aborted through Windows, not by deleting a row.
        if (pendingId is "win-shutdown" or "win-restart")
        {
            bool aborted = NativeMethods.AbortSystemShutdown(null);
            _store.DeletePendingPowerAction(pendingId);
            if (!aborted)
            {
                int error = Marshal.GetLastWin32Error();
                return CommandExecution.Failed(
                    "agent-error",
                    $"Windows refused to abort the pending shutdown (error {error}).",
                    "The shutdown may already be in progress.");
            }

            _store.RecordLocalAudit("power.cancel", "success", new { pendingId });
            return CommandExecution.Success(new { pendingActionId = pendingId, cancelled = true });
        }

        bool removed = _store.DeletePendingPowerAction(pendingId);
        _store.RecordLocalAudit("power.cancel", removed ? "success" : "failure", new { pendingId });
        return CommandExecution.Success(new { pendingActionId = pendingId, cancelled = removed });
    }

    private CommandExecution Pending()
    {
        var actions = _store.PendingPowerActions().Select(action => new
        {
            pendingActionId = action.PendingActionId,
            action = action.Action,
            runAt = action.RunAt.ToString("o"),
            force = action.Force,
            requestedBy = action.RequestedBy,
            cancellable = true,
        });

        return CommandExecution.Success(new { actions });
    }

    // -----------------------------------------------------------------------
    // Execution
    // -----------------------------------------------------------------------

    /// <summary>
    /// Lock the console session, through the process that can.
    ///
    /// Not a question of privilege: this service is already LocalSystem and still cannot do
    /// it, because `LockWorkStation` affects only the caller's own session and a service's is
    /// session 0, which has no desktop to lock. The session host is already running in the
    /// interactive session for screen capture, so it is asked.
    ///
    /// Nobody being signed in is a real answer rather than a failure — there is no session to
    /// lock, and a PC at the sign-in screen is in the state the operator wanted anyway.
    /// </summary>
    private async Task<CommandExecution> LockAsync()
    {
        HostActionResultMessage result = await _sessionHost
            .PerformActionAsync(IpcActions.LockSession, CancellationToken.None)
            .ConfigureAwait(false);

        if (result.Ok)
        {
            _logger.LogInformation("Locked the console session.");

            // Windows queues the lock and returns; there is no supported way to observe it
            // completing. Reported as requested rather than as done, because claiming the
            // screen is locked when the call has only been accepted would be a claim about
            // somebody's privacy that WOLF cannot check.
            return CommandExecution.Success(new { action = "lock", requested = true });
        }

        return result.Limitation
            ? CommandExecution.Limitation(
                result.Code ?? "capability-unavailable",
                result.Message ?? "This PC cannot lock its console session right now.",
                "Locking needs somebody signed in at the PC. It works again once they are.")
            : CommandExecution.Failed(
                result.Code ?? "agent-error",
                result.Message ?? "The console session could not be locked.",
                "Try again in a moment.");
    }

    private async Task<CommandExecution> PerformAsync(string action, bool force)
    {
        switch (action)
        {
            case "lock":
                return await LockAsync().ConfigureAwait(false);

            case "sign-out":
                return SignOut();

            case "sleep":
            case "hibernate":
                bool hibernate = action == "hibernate";
                if (!NativeMethods.SetSuspendState(hibernate, force, false))
                {
                    int error = Marshal.GetLastWin32Error();
                    return CommandExecution.Failed(
                        "agent-error",
                        $"Windows refused the {action} request (error {error}).",
                        "Check that this power state is enabled in Windows power options.");
                }

                _store.RecordLocalAudit($"power.{action}", "success");
                return CommandExecution.Success(new { });

            case "shutdown":
            case "restart":
                return InitiateShutdown(action, 0, force, null);

            default:
                return CommandExecution.Failed("invalid-payload", $"Unknown power action \"{action}\".");
        }
    }

    private CommandExecution SignOut()
    {
        uint sessionId = NativeMethods.WTSGetActiveConsoleSessionId();
        if (sessionId == 0xFFFFFFFF)
        {
            return CommandExecution.Limitation(
                "capability-unavailable",
                "There is no console session to sign out.",
                "Nobody is signed in at the console.");
        }

        if (!NativeMethods.WTSLogoffSession(IntPtr.Zero, sessionId, false))
        {
            int error = Marshal.GetLastWin32Error();
            return CommandExecution.Failed(
                "agent-error",
                $"Windows refused the sign-out request (error {error}).");
        }

        _store.RecordLocalAudit("power.sign-out", "success", new { sessionId });
        return CommandExecution.Success(new { });
    }

    private CommandExecution InitiateShutdown(string action, int delaySeconds, bool force, string? reason)
    {
        if (!EnableShutdownPrivilege())
        {
            return CommandExecution.Limitation(
                "requires-elevation",
                "The WOLF agent does not hold the Windows shutdown privilege.",
                "The agent service must run as a account that has SeShutdownPrivilege.");
        }

        bool reboot = action == "restart";
        string message = reason is null
            ? $"WOLF is performing a remote {action}."
            : $"WOLF is performing a remote {action}: {reason}";

        bool ok = NativeMethods.InitiateSystemShutdownEx(
            null,
            message,
            (uint)Math.Max(0, delaySeconds),
            force,
            reboot,
            NativeMethods.ShutdownReasonPlanned |
            NativeMethods.ShutdownReasonMajorOther |
            NativeMethods.ShutdownReasonMinorOther);

        if (!ok)
        {
            int error = Marshal.GetLastWin32Error();
            return CommandExecution.Failed(
                "agent-error",
                $"Windows refused the {action} request (error {error}).",
                "Check the Windows event log for the shutdown request.");
        }

        _store.RecordLocalAudit($"power.{action}", "success", new { delaySeconds, force });
        return CommandExecution.Success(new { });
    }

    /// <summary>
    /// Enable SeShutdownPrivilege on the agent's own token. The privilege is present but
    /// disabled by default for LocalSystem; enabling it is required before Windows will
    /// accept a shutdown request.
    /// </summary>
    private static bool EnableShutdownPrivilege()
    {
        if (!NativeMethods.OpenProcessToken(
                System.Diagnostics.Process.GetCurrentProcess().Handle,
                NativeMethods.TokenAdjustPrivileges | NativeMethods.TokenQuery,
                out IntPtr token))
        {
            return false;
        }

        try
        {
            if (!NativeMethods.LookupPrivilegeValue(null, NativeMethods.SeShutdownName, out NativeMethods.Luid luid))
            {
                return false;
            }

            var privileges = new NativeMethods.TokenPrivileges
            {
                PrivilegeCount = 1,
                Privileges = new NativeMethods.LuidAndAttributes
                {
                    Luid = luid,
                    Attributes = NativeMethods.SePrivilegeEnabled,
                },
            };

            if (!NativeMethods.AdjustTokenPrivileges(
                    token, false, ref privileges,
                    (uint)Marshal.SizeOf<NativeMethods.TokenPrivileges>(), IntPtr.Zero, IntPtr.Zero))
            {
                return false;
            }

            // AdjustTokenPrivileges reports success even when it could not assign every
            // privilege, so the real answer is in GetLastError.
            return Marshal.GetLastWin32Error() == 0;
        }
        finally
        {
            NativeMethods.CloseHandle(token);
        }
    }

    // -----------------------------------------------------------------------
    // Scheduling
    // -----------------------------------------------------------------------

    /// <summary>
    /// Drop scheduled actions whose time passed while the agent was not running.
    ///
    /// This is the rule that keeps a queued shutdown from firing at an arbitrary moment
    /// after a reboot or a reconnect: a missed schedule is abandoned, not caught up.
    /// </summary>
    private void DiscardOverdueActions()
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        foreach (PendingPowerAction action in _store.PendingPowerActions())
        {
            if (action.RunAt <= now)
            {
                _store.DeletePendingPowerAction(action.PendingActionId);
                _store.RecordLocalAudit("power.schedule.missed", "failure", new
                {
                    action.Action,
                    runAt = action.RunAt.ToString("o"),
                });
                _logger.LogWarning(
                    "Discarded a scheduled {Action} that was due at {RunAt} while the agent was not running.",
                    action.Action,
                    action.RunAt);
            }
        }
    }

    private void RunDueActions()
    {
        lock (_gate)
        {
            DateTimeOffset now = DateTimeOffset.UtcNow;
            foreach (PendingPowerAction action in _store.PendingPowerActions())
            {
                // Windows owns its own countdown; those rows exist only so the UI can show
                // and cancel them.
                if (action.PendingActionId.StartsWith("win-", StringComparison.Ordinal))
                {
                    if (action.RunAt <= now)
                    {
                        _store.DeletePendingPowerAction(action.PendingActionId);
                    }

                    continue;
                }

                if (action.RunAt > now)
                {
                    continue;
                }

                _store.DeletePendingPowerAction(action.PendingActionId);
                _logger.LogInformation("Running scheduled {Action}.", action.Action);
                CommandExecution outcome = PerformAsync(action.Action, action.Force)
                    .ConfigureAwait(false)
                    .GetAwaiter()
                    .GetResult();
                _store.RecordLocalAudit(
                    $"power.{action.Action}",
                    outcome.Failure is null ? "success" : "failure",
                    new { scheduled = true, action.PendingActionId });
            }
        }
    }

    public void Dispose() => _scheduler.Dispose();
}
