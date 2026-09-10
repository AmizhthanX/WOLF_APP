using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Wolf.Agent.SessionHost.Displays;

/// <summary>Which desktop within the session is currently receiving input.</summary>
public enum InputDesktopState
{
    /// <summary>Could not be determined. Never treated as "the desktop is fine".</summary>
    Unknown,

    /// <summary>The ordinary user desktop. This process can see it and inject into it.</summary>
    UserDesktop,

    /// <summary>
    /// A desktop this process is not allowed to open.
    ///
    /// In practice the secure desktop: the lock screen, the sign-in screen, or a UAC prompt.
    /// A process running as the signed-in user cannot open it, and being refused is exactly
    /// how it finds out that is where input is going.
    /// </summary>
    Secure,
}

/// <summary>
/// Answers which desktop has the input, by asking Windows rather than inferring it.
///
/// The agent has been guessing at this: a service in session 0 has no supported way to ask
/// whether a session is locked, so it looked for `LogonUI.exe` in the console session and
/// took its presence as "locked". That works most of the time and is wrong in the ways
/// guesses usually are — LogonUI lingers briefly after an unlock, and a UAC prompt on the
/// secure desktop does not start it at all.
///
/// A process *inside* the session can do better. `OpenInputDesktop` succeeds when the
/// desktop receiving input is one this process may open, and fails with access denied when
/// it is the secure desktop. That refusal is not an error to be logged and shrugged at — it
/// is the answer.
///
/// The one thing this cannot do is name the secure desktop it was refused. Windows does not
/// tell an unprivileged caller which desktop it just declined to open, so "something I am
/// not allowed to see" is the honest limit of what this reports, and telling a lock screen
/// from a UAC prompt is left to the component that can attach to it.
/// </summary>
[SupportedOSPlatform("windows")]
public static class InputDesktop
{
    /// <summary>Which desktop currently has the input.</summary>
    public static InputDesktopState Query()
    {
        // No DESKTOP_ rights are asked for beyond opening it. The question is whether this
        // process *may* open the input desktop at all, and asking for more access than that
        // would turn a "yes" into a "no" on a desktop it could perfectly well read.
        IntPtr desktop = OpenInputDesktop(0, false, DesktopReadobjects);

        if (desktop == IntPtr.Zero)
        {
            int error = Marshal.GetLastWin32Error();

            // Access denied means the input desktop belongs to Winlogon. Anything else means
            // the question could not be answered, which is reported as unknown rather than
            // guessed either way.
            return error == ErrorAccessDenied ? InputDesktopState.Secure : InputDesktopState.Unknown;
        }

        try
        {
            return NameOf(desktop) is "Winlogon" or "Screen-saver"
                ? InputDesktopState.Secure
                : InputDesktopState.UserDesktop;
        }
        finally
        {
            CloseDesktop(desktop);
        }
    }

    /// <summary>
    /// The desktop's name, or null when Windows will not say.
    ///
    /// Read even though being *able* to open the desktop already implies it is not the
    /// secure one: a process running as SYSTEM can open Winlogon, so for the secure host the
    /// name is the only thing that distinguishes the two.
    /// </summary>
    private static string? NameOf(IntPtr desktop)
    {
        var buffer = new byte[256];

        if (!GetUserObjectInformation(desktop, UoiName, buffer, (uint)buffer.Length, out uint needed))
        {
            return null;
        }

        int length = (int)Math.Min(needed, (uint)buffer.Length);
        if (length <= 2) return null;

        // Unicode, and the returned length includes the terminator.
        return System.Text.Encoding.Unicode.GetString(buffer, 0, length - 2);
    }

    private const int ErrorAccessDenied = 5;
    private const uint DesktopReadobjects = 0x0001;
    private const int UoiName = 2;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr OpenInputDesktop(uint flags, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint access);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseDesktop(IntPtr desktop);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetUserObjectInformationW", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetUserObjectInformation(
        IntPtr handle,
        int index,
        byte[] info,
        uint length,
        out uint lengthNeeded);
}
