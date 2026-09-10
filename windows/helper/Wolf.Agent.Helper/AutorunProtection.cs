namespace Wolf.Agent.Helper;

/// <summary>
/// What WOLF refuses to touch among scheduled tasks and startup items.
///
/// The same question as <see cref="ServiceProtection"/> and <see cref="DeviceProtection"/>:
/// *if this goes wrong, can it be undone from the other end of a network?* But these two
/// features add a second question that services do not raise, and it is the more important
/// one here.
///
/// ## Scheduled tasks and startup items are how persistence works
///
/// A scheduled task and a `Run` key are the two mechanisms every piece of Windows malware
/// reaches for, in that order. A remote-management tool that can *create* either is a remote
/// persistence tool, whatever else it is — so WOLF creates neither, ever:
///
/// - **Scheduled tasks:** listed, run, enabled and disabled. Never registered, never deleted.
/// - **Startup items:** listed, enabled and disabled — and disabling is done by writing the
///   same approval flag Task Manager writes, not by removing the entry. WOLF never adds a
///   startup entry and never deletes one.
///
/// That boundary is worth more than any list below. A list can be incomplete; "there is no
/// code path that creates one" cannot be.
///
/// ## And the usual question on top
///
/// Disabling the task that keeps a machine's clock right is recoverable. Disabling the one
/// that repairs a broken component store, or the scheduler's own maintenance, is the kind of
/// slow damage nobody attributes to the right cause months later — so those are refused rather
/// than confirmed.
/// </summary>
public static class AutorunProtection
{
    /// <summary>
    /// Task folders whose contents WOLF will not disable.
    ///
    /// Folders rather than individual tasks, because the set inside them differs by Windows
    /// build and a list of names would be quietly wrong on half the machines it ran on. The
    /// cost is that some harmless task in one of these folders cannot be disabled remotely,
    /// which is a much smaller loss than a machine that stops updating and does not say so.
    /// </summary>
    private static readonly string[] ProtectedFolders =
    {
        // The scheduler's own maintenance. Disabling these breaks the mechanism that would
        // be used to fix anything else.
        @"\Microsoft\Windows\TaskScheduler",
        // Servicing: the component store, update orchestration, and the pieces that repair a
        // machine that has gone wrong. Disabling one produces slow damage nobody attributes
        // to the right cause months later.
        @"\Microsoft\Windows\Servicing",
        @"\Microsoft\Windows\WindowsUpdate",
        @"\Microsoft\Windows\UpdateOrchestrator",
        @"\Microsoft\Windows\SoftwareProtectionPlatform",
        // The machine's own state: restore points, disk checks, the clock. Every one of these
        // is something whose absence is only noticed when it is needed.
        @"\Microsoft\Windows\SystemRestore",
        @"\Microsoft\Windows\Chkdsk",
        @"\Microsoft\Windows\Time Synchronization",
        // Recovery and boot.
        @"\Microsoft\Windows\Diagnosis",
        @"\Microsoft\Windows\ErrorDetails",
        @"\Microsoft\Windows\Maintenance",
        // Security. Turning Defender's own tasks off from a remote session is exactly what an
        // attacker with a WOLF session would want to do first.
        @"\Microsoft\Windows\Windows Defender",
        @"\Microsoft\Windows\ExploitGuard",
    };

    /// <summary>WOLF's own scheduled work, whatever it ends up being called.</summary>
    private const string OwnPrefix = @"\WOLF";

    /// <summary>
    /// Whether WOLF will disable this scheduled task.
    ///
    /// Takes the full path — `\Microsoft\Windows\Defrag\ScheduledDefrag` — because the folder
    /// is the thing being decided about and a bare name loses it.
    /// </summary>
    public static ServiceRefusal? WhyNotTask(string taskPath)
    {
        if (string.IsNullOrWhiteSpace(taskPath))
        {
            return new ServiceRefusal("unknown-task", "No task was named.");
        }

        string path = taskPath.StartsWith('\\') ? taskPath : "\\" + taskPath;

        if (path.StartsWith(OwnPrefix + "\\", StringComparison.OrdinalIgnoreCase) ||
            path.Equals(OwnPrefix, StringComparison.OrdinalIgnoreCase))
        {
            return new ServiceRefusal(
                "wolf-task",
                "That is WOLF's own scheduled work. Disabling it from a WOLF session is a way " +
                "to lose the session and the means of undoing it. Use the WOLF control panel " +
                "on the PC itself.");
        }

        foreach (string folder in ProtectedFolders)
        {
            if (path.StartsWith(folder + "\\", StringComparison.OrdinalIgnoreCase) ||
                path.Equals(folder, StringComparison.OrdinalIgnoreCase))
            {
                return new ServiceRefusal(
                    "system-critical",
                    "That task is part of how Windows keeps itself working — servicing, " +
                    "recovery, or security. Disabling it remotely causes damage that is not " +
                    "noticed until something else fails.");
            }
        }

        return null;
    }

    /// <summary>
    /// Whether WOLF will perform this action on this task.
    ///
    /// Enabling and running are allowed anywhere, including in the protected folders. The
    /// asymmetry is the same one the service and device rules make: those directions restore
    /// function or repeat something the machine was already going to do, and both can be
    /// undone. Disabling is the one that cannot.
    /// </summary>
    public static ServiceRefusal? CheckTask(string taskPath, string action) =>
        action == "disable" ? WhyNotTask(taskPath) : null;

    /// <summary>Every task folder WOLF will not disable, for a client to show.</summary>
    public static IReadOnlyList<string> ProtectedTaskFolders() => ProtectedFolders;

    /// <summary>
    /// Startup entries WOLF will not disable.
    ///
    /// A much shorter list than the task one, because a `Run` entry is by nature third-party:
    /// Windows starts its own things through services and tasks, not through `Run`. What is
    /// here is WOLF itself and the shell — `explorer.exe` is registered as a shell rather than
    /// a `Run` entry on a healthy machine, and an entry claiming to be it on a machine where
    /// it is one is not something to switch off from a remote session.
    /// </summary>
    public static ServiceRefusal? WhyNotStartup(string name, string? command)
    {
        string haystack = $"{name} {command}".ToLowerInvariant();

        if (haystack.Contains("wolf.agent", StringComparison.Ordinal) ||
            haystack.Contains("wolfagent", StringComparison.Ordinal))
        {
            return new ServiceRefusal(
                "wolf-startup",
                "That is WOLF's own startup entry. Use the WOLF control panel on the PC itself.");
        }

        if (haystack.Contains("explorer.exe", StringComparison.Ordinal))
        {
            return new ServiceRefusal(
                "system-critical",
                "That entry starts the Windows shell. Disabling it leaves a machine with no " +
                "desktop for whoever signs in next.");
        }

        return null;
    }

    /// <summary>Whether WOLF will perform this action on this startup entry.</summary>
    public static ServiceRefusal? CheckStartup(string name, string? command, bool enable) =>
        enable ? null : WhyNotStartup(name, command);
}
