using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Microsoft.Extensions.Logging;
using Wolf.Agent.Core.Ipc;

namespace Wolf.Agent.SessionHost;

/// <summary>
/// Things only a process inside the interactive session can do.
///
/// A short list, and it will stay short. The session host exists to capture a screen and
/// inject input; everything here is something the agent service asked for and physically
/// cannot do itself, not a general remote-control surface.
///
/// This is not about privilege. The agent runs as LocalSystem and still cannot lock the
/// console session, because `LockWorkStation` affects the caller's own session and the
/// service's is session 0, which has no desktop to lock.
/// </summary>
[SupportedOSPlatform("windows")]
public static class SessionActions
{
    /// <summary>
    /// Perform one action and say what happened.
    ///
    /// Refuses anything not on the allow-list, checked here as well as in the service: this
    /// is the process with the desktop, so it is the boundary that counts.
    /// </summary>
    public static HostActionResultMessage Perform(string requestId, string action, ILogger logger)
    {
        if (!IpcActions.IsAllowed(action))
        {
            logger.LogWarning("Refused an action the session host does not have: {Action}.", action);

            return new HostActionResultMessage(
                requestId,
                Ok: false,
                Code: "not-allowed",
                Message: $"The WOLF session host does not perform '{action}'.",
                Limitation: false);
        }

        return action switch
        {
            IpcActions.LockSession => LockSession(requestId, logger),

            // Unreachable while the allow-list above is checked first. Kept so adding a name
            // without an implementation fails loudly rather than reporting success.
            _ => new HostActionResultMessage(
                requestId,
                Ok: false,
                Code: "not-implemented",
                Message: $"'{action}' is allowed but not implemented.",
                Limitation: false),
        };
    }

    private static HostActionResultMessage LockSession(string requestId, ILogger logger)
    {
        if (LockWorkStation())
        {
            logger.LogInformation("Locked the interactive session at the agent's request.");
            return new HostActionResultMessage(requestId, Ok: true, Code: null, Message: null, Limitation: false);
        }

        int error = Marshal.GetLastWin32Error();
        logger.LogWarning("Windows refused to lock the session (error {Error}).", error);

        return new HostActionResultMessage(
            requestId,
            Ok: false,
            Code: "windows-refused",
            Message: $"Windows would not lock this session (error {error}).",

            // Windows refusing is Windows' decision, not WOLF failing: it declines while a
            // shutdown is already under way, and on a session that has no interactive
            // desktop to lock.
            Limitation: true);
    }

    /// <summary>
    /// Locks the session this process is running in.
    ///
    /// Asynchronous in Windows' own terms: it returns as soon as the request is queued, so a
    /// success here means "Windows accepted it", not "the screen is already locked". Worth
    /// knowing, but not worth waiting for — there is no supported way to observe the lock
    /// completing, and inferring one from the presence of LogonUI would be a guess.
    /// </summary>
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool LockWorkStation();
}
