using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Wolf.Agent.Core.Native;

/// <summary>
/// Interop for launching a process into an interactive session.
///
/// These use <c>DllImport</c> rather than <c>LibraryImport</c>: the process-creation APIs
/// take structures containing string pointers, which the source generator cannot marshal
/// without a hand-written marshaller. Writing that marshaller would be more code and more
/// risk than the runtime marshalling these few calls need.
/// </summary>
#pragma warning disable SYSLIB1054 // See the note above: these signatures need runtime marshalling.
[SupportedOSPlatform("windows")]
internal static class SessionNativeMethods
{
    internal const uint CreateUnicodeEnvironment = 0x00000400;
    internal const uint CreateNewConsole = 0x00000010;
    internal const uint CreateNoWindow = 0x08000000;

    internal const uint MaximumAllowed = 0x02000000;

    internal enum SecurityImpersonationLevel
    {
        SecurityIdentification = 1,
        SecurityImpersonation = 2,
    }

    internal enum TokenType
    {
        TokenPrimary = 1,
        TokenImpersonation = 2,
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct StartupInfo
    {
        public int cb;
        public string? lpReserved;
        /// <summary>Must name the desktop, e.g. "winsta0\\default", or the process has none.</summary>
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
    internal struct ProcessInformation
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct SecurityAttributes
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        public bool bInheritHandle;
    }

    /// <summary>Obtain the primary token of the user signed in to a session. Needs SYSTEM.</summary>
    [DllImport("wtsapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool WTSQueryUserToken(uint sessionId, out IntPtr phToken);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool DuplicateTokenEx(
        IntPtr hExistingToken,
        uint dwDesiredAccess,
        IntPtr lpTokenAttributes,
        SecurityImpersonationLevel impersonationLevel,
        TokenType tokenType,
        out IntPtr phNewToken);

    /// <summary>Build the environment block for the user, so the host sees their profile.</summary>
    [DllImport("userenv.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CreateEnvironmentBlock(
        out IntPtr lpEnvironment,
        IntPtr hToken,
        [MarshalAs(UnmanagedType.Bool)] bool bInherit);

    [DllImport("userenv.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool DestroyEnvironmentBlock(IntPtr lpEnvironment);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CreateProcessAsUser(
        IntPtr hToken,
        string? lpApplicationName,
        string? lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string? lpCurrentDirectory,
        ref StartupInfo lpStartupInfo,
        out ProcessInformation lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CloseHandle(IntPtr hObject);
}
#pragma warning restore SYSLIB1054
