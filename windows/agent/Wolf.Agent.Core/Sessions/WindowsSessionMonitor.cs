using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Microsoft.Extensions.Logging;
using Wolf.Agent.Core.Native;
using Wolf.Agent.Core.Protocol;

namespace Wolf.Agent.Core.Sessions;

/// <summary>
/// Reports which Windows session state the console is in.
///
/// This is a genuinely hard thing to know from a service in session 0, and WOLF does not
/// pretend otherwise. The connection state comes from the terminal services API and is
/// reliable. Distinguishing a *locked* desktop from an unlocked one is not exposed by any
/// supported query, so it is inferred from the presence of LogonUI.exe in the console
/// session — the process Windows runs to draw the lock and sign-in screens.
///
/// That inference is documented rather than hidden: when the console session cannot be
/// resolved at all, the state is reported as <c>unknown</c>, never optimistically as
/// <c>desktop</c>, because a caller acting on a wrong answer here could send input to a
/// screen that is not what they think it is.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class WindowsSessionMonitor
{
    private readonly ILogger<WindowsSessionMonitor> _logger;

    public WindowsSessionMonitor(ILogger<WindowsSessionMonitor> logger)
    {
        _logger = logger;
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
            NativeMethods.WtsConnectState.Active => LogonUiPresent(sessionId) ? "locked" : "desktop",
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
