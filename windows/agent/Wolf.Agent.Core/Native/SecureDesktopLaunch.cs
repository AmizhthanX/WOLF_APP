using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Microsoft.Extensions.Logging;

namespace Wolf.Agent.Core.Native;

/// <summary>Why a secure-desktop host could not be started, when it could not.</summary>
public sealed record SecureLaunchFailure(string Code, string Message, bool Limitation);

/// <summary>
/// Starts a process on the secure desktop, as SYSTEM, in the console session.
///
/// The lock screen and the sign-in screen are not windows on the user's desktop — they are a
/// separate desktop within the session, `winsta0\Winlogon`, and only SYSTEM may open it.
/// That is a deliberate Windows boundary: it is what stops a program the signed-in user is
/// running from watching them type their password.
///
/// WOLF does not weaken it. It does what Windows' own accessibility and remote-assistance
/// components do: the service, which is already LocalSystem, launches a process *onto* that
/// desktop. The child has exactly the access SYSTEM already had — no privilege is created,
/// and nothing running as the user gains anything.
///
/// Three things have to be true and none of them are optional:
///
/// 1. **This process must be SYSTEM.** Duplicating the current token is how the child gets
///    SYSTEM, so an agent running as anything else produces a child running as that instead
///    — which cannot open Winlogon and would fail confusingly later.
/// 2. **The token's session must be set to the console session.** A service's token is in
///    session 0, and a process created with it lands there, where there is no desktop at all.
///    Changing it needs `SeTcbPrivilege`, which LocalSystem has and almost nothing else does.
/// 3. **The desktop must be named at creation.** There is no supported way to move a process
///    between desktops afterwards.
///
/// **None of this has ever run.** It needs the agent installed as a Windows service, and a
/// machine whose screen can be locked while somebody watches what happens. The development
/// machine this was written on is neither. Every failure path below is reported distinctly
/// rather than collapsed into "could not start", because the first person to run it will be
/// reading those messages to find out which of the three conditions this codebase got wrong.
/// </summary>
[SupportedOSPlatform("windows")]
public static class SecureDesktopLaunch
{
    /// <summary>The desktop the lock and sign-in screens are drawn on.</summary>
    public const string SecureDesktop = @"winsta0\Winlogon";

    /// <summary>
    /// Whether a secure-desktop host could be started at all, without starting one.
    ///
    /// Answered for the capability handshake. It reports what is *possible*, which is not the
    /// same as what has happened: a machine that passes this can still fail to launch, and
    /// the stream reports that when it tries.
    /// </summary>
    public static SecureLaunchFailure? CheckPreconditions(string executablePath)
    {
        if (!File.Exists(executablePath))
        {
            return new SecureLaunchFailure(
                "not-installed",
                "The WOLF session host is not installed beside the agent, so the lock screen cannot be captured.",
                Limitation: false);
        }

        if (!RunningAsSystem())
        {
            // Said plainly rather than attempted and failed. An agent started by hand for
            // development is not SYSTEM, and the honest answer is that this needs the
            // service — not an access-denied three calls later that reads like a bug.
            return new SecureLaunchFailure(
                "not-system",
                "Capturing the lock screen needs the WOLF agent running as a Windows service. " +
                "It is running as an ordinary account here.",
                Limitation: true);
        }

        if (NativeMethods.WTSGetActiveConsoleSessionId() == 0xFFFFFFFF)
        {
            return new SecureLaunchFailure(
                "no-console-session",
                "No session is attached to the console, so there is no lock screen to capture.",
                Limitation: true);
        }

        return null;
    }

    /// <summary>Launch a process onto the secure desktop of the console session.</summary>
    public static (Process? Process, SecureLaunchFailure? Failure) TryStart(
        string executablePath,
        string arguments,
        ILogger logger)
    {
        if (CheckPreconditions(executablePath) is { } precondition) return (null, precondition);

        uint sessionId = NativeMethods.WTSGetActiveConsoleSessionId();

        IntPtr token = IntPtr.Zero;
        IntPtr duplicated = IntPtr.Zero;

        try
        {
            if (!OpenProcessToken(GetCurrentProcess(), TokenDuplicate | TokenQuery, out token))
            {
                return (null, Win32Failure("open-token", "read this process's own token"));
            }

            if (!DuplicateTokenEx(
                    token,
                    TokenAllAccess,
                    IntPtr.Zero,
                    SecurityImpersonation,
                    TokenPrimary,
                    out duplicated))
            {
                return (null, Win32Failure("duplicate-token", "duplicate the agent's token"));
            }

            // Move the token into the console session. Without this the child is created in
            // session 0, which has no desktop at all — the very problem the session host
            // exists to solve.
            uint target = sessionId;
            if (!SetTokenInformation(duplicated, TokenSessionId, ref target, sizeof(uint)))
            {
                return (null, Win32Failure("set-session", "move the token into the console session"));
            }

            var startup = new Startupinfo
            {
                cb = Marshal.SizeOf<Startupinfo>(),

                // The only moment a process's desktop can be chosen.
                lpDesktop = SecureDesktop,
            };

            if (!CreateProcessAsUser(
                    duplicated,
                    executablePath,
                    BuildCommandLine(executablePath, arguments),
                    IntPtr.Zero,
                    IntPtr.Zero,
                    false,
                    CreateNoWindow | CreateUnicodeEnvironment,
                    IntPtr.Zero,
                    Path.GetDirectoryName(executablePath),
                    ref startup,
                    out ProcessInformation info))
            {
                return (null, Win32Failure("create-process", "start a process on the secure desktop"));
            }

            CloseHandle(info.hThread);

            logger.LogInformation(
                "Started the secure-desktop host as process {Pid} in session {Session}.",
                info.dwProcessId,
                sessionId);

            try
            {
                return (Process.GetProcessById(info.dwProcessId), null);
            }
            catch (ArgumentException)
            {
                // Started and exited before it could be looked up. Reported rather than
                // returned as a running process nobody can wait on.
                CloseHandle(info.hProcess);
                return (null, new SecureLaunchFailure(
                    "exited-immediately",
                    "The secure-desktop host started and stopped straight away.",
                    Limitation: false));
            }
        }
        finally
        {
            if (duplicated != IntPtr.Zero) CloseHandle(duplicated);
            if (token != IntPtr.Zero) CloseHandle(token);
        }
    }

    /// <summary>
    /// Whether this process is LocalSystem.
    ///
    /// Checked rather than assumed because the whole mechanism depends on it: the child gets
    /// SYSTEM by inheriting it from here, so an agent running as anything else silently
    /// produces a child that cannot open the desktop it was launched onto.
    /// </summary>
    public static bool RunningAsSystem()
    {
        try
        {
            using System.Security.Principal.WindowsIdentity identity =
                System.Security.Principal.WindowsIdentity.GetCurrent();

            return identity.User is { } user &&
                   user.IsWellKnown(System.Security.Principal.WellKnownSidType.LocalSystemSid);
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or System.Security.SecurityException)
        {
            return false;
        }
    }

    /// <summary>
    /// The command line, with the executable quoted as argument zero.
    ///
    /// Built here because <c>CreateProcessAsUser</c> takes the application path and the
    /// command line separately, and an unquoted path with a space in it is the classic way to
    /// end up running something else entirely.
    /// </summary>
    public static string BuildCommandLine(string executablePath, string arguments) =>
        arguments.Length == 0
            ? $"\"{executablePath}\""
            : $"\"{executablePath}\" {arguments}";

    private static SecureLaunchFailure Win32Failure(string code, string what)
    {
        var error = new Win32Exception(Marshal.GetLastWin32Error());
        return new SecureLaunchFailure(code, $"Windows would not let WOLF {what}: {error.Message}", false);
    }

    private const uint TokenDuplicate = 0x0002;
    private const uint TokenQuery = 0x0008;
    private const uint TokenAllAccess = 0xF01FF;
    private const int SecurityImpersonation = 2;
    private const int TokenPrimary = 1;
    private const int TokenSessionId = 12;
    private const uint CreateNoWindow = 0x08000000;
    private const uint CreateUnicodeEnvironment = 0x00000400;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Startupinfo
    {
        public int cb;
        public string? lpReserved;
        public string? lpDesktop;
        public string? lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DuplicateTokenEx(
        IntPtr existing,
        uint access,
        IntPtr attributes,
        int impersonationLevel,
        int tokenType,
        out IntPtr duplicated);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetTokenInformation(
        IntPtr token,
        int informationClass,
        ref uint information,
        int length);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, EntryPoint = "CreateProcessAsUserW", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessAsUser(
        IntPtr token,
        string applicationName,
        string commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string? currentDirectory,
        ref Startupinfo startupInfo,
        out ProcessInformation processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
}
