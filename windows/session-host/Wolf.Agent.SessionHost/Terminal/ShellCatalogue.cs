using System.Runtime.Versioning;

namespace Wolf.Agent.SessionHost.Terminal;

/// <summary>A shell WOLF will start, and where it actually is on this machine.</summary>
public sealed record ResolvedShell(string Name, string ExecutablePath, string CommandLine);

/// <summary>
/// The shells WOLF will start, and nothing else.
///
/// The whole point of naming shells rather than accepting paths. A caller that could supply
/// `C:\anything.exe` would turn "give me a shell" into "run this program as the signed-in
/// user", which is a materially larger thing than the capability grant says it is — and it
/// would do it *before* any shell exists to be audited as one.
///
/// The names are fixed here; the paths are resolved from Windows rather than hard-coded, so
/// a machine with Windows somewhere other than `C:\Windows` works and a machine without
/// PowerShell 7 says so instead of failing to start a process nobody can see.
/// </summary>
[SupportedOSPlatform("windows")]
public static class ShellCatalogue
{
    /// <summary>Shells the protocol names. Anything else is not a shell as far as WOLF is concerned.</summary>
    public static readonly IReadOnlyList<string> Names = new[] { "cmd", "powershell", "pwsh" };

    /// <summary>
    /// Find a named shell, or say why it is not here.
    ///
    /// Returns null for a shell that is not installed — which is a real answer on a real
    /// machine, because PowerShell 7 is an optional install and plenty of PCs do not have it.
    /// </summary>
    public static ResolvedShell? Resolve(string name)
    {
        string system = Environment.GetFolderPath(Environment.SpecialFolder.System);

        return name switch
        {
            "cmd" => Existing("cmd", Path.Combine(system, "cmd.exe")),

            "powershell" => Existing(
                "powershell",
                Path.Combine(system, "WindowsPowerShell", "v1.0", "powershell.exe"),
                // -NoLogo because the banner is three lines of nothing on every open, and
                // -NoProfile is deliberately *not* set: the operator's profile is part of
                // the shell that machine actually has, which is what they are here to see.
                "-NoLogo"),

            "pwsh" => FindPwsh(),

            _ => null,
        };
    }

    /// <summary>
    /// PowerShell 7, wherever it was installed.
    ///
    /// Checked against the file system rather than PATH: PATH in this process is the session
    /// host's, and a shell resolved from it would depend on how the agent happened to be
    /// started rather than on what is installed.
    /// </summary>
    private static ResolvedShell? FindPwsh()
    {
        foreach (Environment.SpecialFolder root in new[]
                 {
                     Environment.SpecialFolder.ProgramFiles,
                     Environment.SpecialFolder.ProgramFilesX86,
                 })
        {
            string candidate = Path.Combine(Environment.GetFolderPath(root), "PowerShell", "7", "pwsh.exe");
            if (File.Exists(candidate)) return new ResolvedShell("pwsh", candidate, Quote(candidate) + " -NoLogo");
        }

        return null;
    }

    private static ResolvedShell? Existing(string name, string path, string? arguments = null)
    {
        if (!File.Exists(path)) return null;

        string commandLine = arguments is null ? Quote(path) : $"{Quote(path)} {arguments}";
        return new ResolvedShell(name, path, commandLine);
    }

    /// <summary>
    /// Quote argument zero.
    ///
    /// An unquoted path with a space in it is the classic way to end up running something
    /// else entirely — here, `C:\Program.exe`. These paths do not have spaces today, and
    /// relying on that is how they acquire one.
    /// </summary>
    private static string Quote(string path) => $"\"{path}\"";
}
