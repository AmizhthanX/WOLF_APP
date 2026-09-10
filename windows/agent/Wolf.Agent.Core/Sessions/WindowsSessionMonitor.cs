using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Microsoft.Extensions.Logging;
using Wolf.Agent.Core.Ipc;
using Wolf.Agent.Core.Native;
using Wolf.Agent.Core.Protocol;

namespace Wolf.Agent.Core.Sessions;

/// <summary>
/// Reports which Windows session state the console is in.
///
/// This is a genuinely hard thing to know from a service in session 0, and WOLF does not
/// pretend otherwise. The connection state comes from the terminal services API and is
/// reliable. Distinguishing a *locked* desktop from an unlocked one is not exposed to a
/// service by any supported query.
///
/// So it is asked of the session host instead, which runs *inside* the session and can put
/// the question to Windows directly: may this process open the desktop that currently has
/// the input? Being refused means the secure desktop has it — the lock screen, the sign-in
/// screen, or a UAC prompt.
///
/// When no host is connected the old inference is used: the presence of `LogonUI.exe` in the
/// console session. It is kept because a PC with nobody signed in has no host and still has
/// a state worth reporting, and it is only a fallback because it is wrong in the ways
/// guesses usually are — LogonUI lingers briefly after an unlock, and a UAC prompt does not
/// start it at all.
///
/// Either way, when the console session cannot be resolved the state is <c>unknown</c>,
/// never optimistically <c>desktop</c>: a caller acting on a wrong answer here could send
/// input to a screen that is not what they think it is.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class WindowsSessionMonitor
{
    private readonly ILogger<WindowsSessionMonitor> _logger;

    /// <summary>
    /// What the session host reports about the input desktop, or unknown when none is
    /// connected. A function rather than a value because it changes under the caller.
    /// </summary>
    private readonly Func<string> _inputDesktop;

    public WindowsSessionMonitor(ILogger<WindowsSessionMonitor> logger)
        : this(logger, () => IpcInputDesktop.Unknown)
    {
    }

    public WindowsSessionMonitor(ILogger<WindowsSessionMonitor> logger, Func<string> inputDesktop)
    {
        _logger = logger;
        _inputDesktop = inputDesktop;
    }

    public SystemSessionStateResult Query()
    {
        string observedAt = DateTimeOffset.UtcNow.ToString("o");

        uint sessionId = NativeMethods.WTSGetActiveConsoleSessionId();
        if (sessionId == 0xFFFFFFFF)
        {
            // No console session is attached: the machine is between sessions, or the
            // console is being switched.
            return new SystemSessionStateResult("unknown", null, null, observedAt);
        }

        NativeMethods.WtsConnectState? connectState = QueryConnectState(sessionId);
        string? userName = QueryUserName(sessionId);

        string state = connectState switch
        {
            null => "unknown",
            NativeMethods.WtsConnectState.Active when string.IsNullOrEmpty(userName) => "login",
            NativeMethods.WtsConnectState.Active => ActiveState(sessionId),
            NativeMethods.WtsConnectState.Disconnected => "locked",
            NativeMethods.WtsConnectState.ConnectQuery or NativeMethods.WtsConnectState.Init => "login",
            NativeMethods.WtsConnectState.Down or NativeMethods.WtsConnectState.Reset => "restarting",
            _ => "unknown",
        };

        return new SystemSessionStateResult(
            state,
            (int)sessionId,
            string.IsNullOrEmpty(userName) ? null : userName,
            observedAt);
    }

    /// <summary>
    /// Locked or not, for a session Windows says is active.
    ///
    /// The host's answer wins wherever it has one. It comes from inside the session and is a
    /// question put to Windows rather than a symptom observed from outside, so there is no
    /// case where the guess is the better answer.
    /// </summary>
    private string ActiveState(uint sessionId)
    {
        string reported = _inputDesktop();

        if (reported == IpcInputDesktop.Secure) return "locked";
        if (reported == IpcInputDesktop.User) return "desktop";

        return LogonUiPresent(sessionId) ? "locked" : "desktop";
    }

    private static NativeMethods.WtsConnectState? QueryConnectState(uint sessionId)
    {
        if (!NativeMethods.WTSQuerySessionInformation(
                IntPtr.Zero,
                sessionId,
                NativeMethods.WtsInfoClass.WtsConnectState,
                out IntPtr buffer,
                out uint returned) || returned < sizeof(int))
        {
            return null;
        }

        try
        {
            return (NativeMethods.WtsConnectState)Marshal.ReadInt32(buffer);
        }
        finally
        {
            NativeMethods.WTSFreeMemory(buffer);
        }
    }

    private static string? QueryUserName(uint sessionId)
    {
        if (!NativeMethods.WTSQuerySessionInformation(
                IntPtr.Zero,
                sessionId,
                NativeMethods.WtsInfoClass.WtsUserName,
                out IntPtr buffer,
                out _))
        {
            return null;
        }

        try
        {
            return Marshal.PtrToStringUni(buffer);
        }
        finally
        {
            NativeMethods.WTSFreeMemory(buffer);
        }
    }

    /// <summary>
    /// LogonUI.exe runs in the console session while the lock or sign-in screen is shown.
    /// Its presence is the most reliable signal available to a service; it is an inference,
    /// not a documented contract, which is why the result is labelled as a best effort.
    /// </summary>
    private bool LogonUiPresent(uint sessionId)
    {
        try
        {
            foreach (Process process in Process.GetProcessesByName("LogonUI"))
            {
                using (process)
                {
                    if (process.SessionId == (int)sessionId)
                    {
                        return true;
                    }
                }
            }
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            _logger.LogDebug(ex, "Could not enumerate LogonUI; lock state is unknown.");
        }

        return false;
    }
}
