using System.Runtime.Versioning;
using Microsoft.Extensions.Logging;

namespace Wolf.Agent.Core.Ipc;

/// <summary>
/// Starts the secure-desktop host while the lock screen has the input, and stops it after.
///
/// The whole policy is two lines long, which is the point: the session host says which
/// desktop has the input, and this turns that into a host that exists or does not. Everything
/// hard is on either side of it — knowing the desktop, and running a process on it.
///
/// Why not simply leave the secure host running? Because it holds a duplication of the
/// display and runs as SYSTEM, and neither is a thing to keep alive for the hours a PC sits
/// unlocked. It costs a couple of seconds to start when the screen locks, and the alternative
/// is a SYSTEM process watching a desktop nobody is looking at.
///
/// **Never run.** Starting the host needs the agent installed as a Windows service, and the
/// screen locked. See <see cref="SecureDesktopSupervisor"/>.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class SecureDesktopWatcher : IAsyncDisposable
{
    private readonly SessionHostSupervisor _sessionHost;
    private readonly SecureDesktopSupervisor _secureHost;
    private readonly ILogger<SecureDesktopWatcher> _logger;

    public SecureDesktopWatcher(
        SessionHostSupervisor sessionHost,
        SecureDesktopSupervisor secureHost,
        ILogger<SecureDesktopWatcher> logger)
    {
        _sessionHost = sessionHost;
        _secureHost = secureHost;
        _logger = logger;
    }

    public void Start() => _sessionHost.InputDesktopChanged += OnInputDesktopChanged;

    private void OnInputDesktopChanged(string inputDesktop)
    {
        if (inputDesktop == IpcInputDesktop.Secure)
        {
            if (!_secureHost.CanCapture())
            {
                // Said once, at the moment it would have mattered, rather than as a
                // capability nobody read. The reason is the operator's to know: "install
                // WOLF as a service" and "nobody is at the console" call for different things.
                _logger.LogInformation(
                    "The secure desktop has the input but cannot be captured here: {Reason}",
                    _secureHost.WhyNot());
                return;
            }

            _logger.LogInformation("The secure desktop has the input; starting a host on it.");
            _secureHost.Start();
            return;
        }

        // Anything else — the user desktop, or an answer nobody could give. Unknown stops it
        // too: a host on a desktop the agent has lost track of is worse than none, because
        // nothing would be watching whether it was still the right one.
        Fire(_secureHost.StopAsync());
    }

    /// <summary>
    /// Run a teardown that nobody is waiting on, without losing its failures.
    ///
    /// This is called from a status handler on the pipe thread, which must not block on a
    /// process being killed.
    /// </summary>
    private void Fire(Task work) => _ = work.ContinueWith(
        task =>
        {
            if (task.Exception is { } error)
            {
                _logger.LogError(error, "Stopping the secure-desktop host failed.");
            }
        },
        TaskScheduler.Default);

    public async ValueTask DisposeAsync()
    {
        _sessionHost.InputDesktopChanged -= OnInputDesktopChanged;
        await _secureHost.StopAsync().ConfigureAwait(false);
    }
}
