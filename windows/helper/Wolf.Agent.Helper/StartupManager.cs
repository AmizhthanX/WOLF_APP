using System.Runtime.Versioning;
using Microsoft.Extensions.Logging;
using Microsoft.Win32;
using Wolf.Agent.Core.Privileged;

namespace Wolf.Agent.Helper;

/// <summary>
/// What starts when somebody signs in.
///
/// Four places, because Windows has four: the machine's `Run` and `RunOnce` keys, the
/// machine's Startup folder, and the same pair again for each signed-in user.
///
/// ## Per-user entries without impersonating anybody
///
/// The helper runs as LocalSystem and has no user hive of its own, but it does not need one:
/// a signed-in user's hive is already mounted under `HKEY_USERS\&lt;their SID&gt;`, so their
/// `Run` key is readable directly. That is simpler than impersonation, needs no token, and
/// works for every user signed in at once rather than only the one at the console.
///
/// A user who is *not* signed in has no mounted hive and their entries are not listed. Said
/// rather than worked around: loading somebody's hive to read it is a much larger thing to do
/// to a machine than reading one that is already open.
///
/// ## WOLF never adds or removes a startup entry
///
/// A `Run` key is the second thing every piece of Windows malware writes, after a scheduled
/// task. So there is no operation here that creates one and none that deletes one — and
/// disabling is done the way Task Manager does it, by writing the `StartupApproved` flag
/// Windows itself reads, leaving the entry intact.
///
/// That matters twice over: an operator can put back what they turned off, and WOLF cannot be
/// used to install persistence even by somebody who has taken over a session.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class StartupManager
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string RunOnceKey = @"Software\Microsoft\Windows\CurrentVersion\RunOnce";
    private const string ApprovedRun = @"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
    private const string ApprovedFolder =
        @"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder";

    /// <summary>Entries returned at once. A machine with more than this has a problem of its own.</summary>
    public const int MaxEntries = 500;

    private readonly ILogger<StartupManager> _logger;

    public StartupManager(ILogger<StartupManager> logger)
    {
        _logger = logger;
    }

    /// <summary>Everything that runs at sign-in, from every place Windows looks.</summary>
    public HelperStartupListResult List()
    {
        var entries = new List<HelperStartupEntry>();

        ReadRegistry(Registry.LocalMachine, RunKey, "machine", "run", null, entries);
        ReadRegistry(Registry.LocalMachine, RunOnceKey, "machine", "run-once", null, entries);
        ReadFolder(Environment.SpecialFolder.CommonStartup, "machine", null, entries);

        foreach ((string sid, string label) in SignedInUsers())
        {
            using RegistryKey? hive = OpenUserHive(sid);
            if (hive is null) continue;

            ReadRegistry(hive, RunKey, "user", "run", label, entries);
            ReadRegistry(hive, RunOnceKey, "user", "run-once", label, entries);
        }

        // The current user's Startup folder is read through the special folder rather than
        // built from a SID, because a redirected Startup folder — which roaming profiles do —
        // is not under the profile path at all.
        ReadFolder(Environment.SpecialFolder.Startup, "user", null, entries);

        entries.Sort((left, right) =>
            string.Compare(left.Name, right.Name, StringComparison.OrdinalIgnoreCase));

        return new HelperStartupListResult(entries, entries.Count >= MaxEntries);
    }

    private void ReadRegistry(
        RegistryKey root,
        string path,
        string scope,
        string source,
        string? user,
        List<HelperStartupEntry> entries)
    {
        try
        {
            using RegistryKey? key = root.OpenSubKey(path, writable: false);
            if (key is null) return;

            using RegistryKey? approved = root.OpenSubKey(ApprovedRun, writable: false);

            foreach (string name in key.GetValueNames())
            {
                if (entries.Count >= MaxEntries) return;

                string? command = key.GetValue(name)?.ToString();

                entries.Add(new HelperStartupEntry(
                    name,
                    command,
                    scope,
                    source,
                    user,
                    IsApproved(approved, name),
                    AutorunProtection.WhyNotStartup(name, command)?.Code));
            }
        }
        catch (Exception ex) when (ex is System.Security.SecurityException or UnauthorizedAccessException or IOException)
        {
            _logger.LogDebug(ex, "A startup key could not be read.");
        }
    }

    private void ReadFolder(
        Environment.SpecialFolder folder,
        string scope,
        string? user,
        List<HelperStartupEntry> entries)
    {
        string path = Environment.GetFolderPath(folder);
        if (string.IsNullOrEmpty(path) || !Directory.Exists(path)) return;

        try
        {
            using RegistryKey? approved =
                (scope == "machine" ? Registry.LocalMachine : Registry.CurrentUser)
                .OpenSubKey(ApprovedFolder, writable: false);

            foreach (string file in Directory.EnumerateFiles(path))
            {
                if (entries.Count >= MaxEntries) return;

                string name = Path.GetFileName(file);

                entries.Add(new HelperStartupEntry(
                    name,
                    file,
                    scope,
                    "startup-folder",
                    user,
                    IsApproved(approved, name),
                    AutorunProtection.WhyNotStartup(name, file)?.Code));
            }
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException or System.Security.SecurityException)
        {
            _logger.LogDebug(ex, "A startup folder could not be read.");
        }
    }

    /// <summary>
    /// Turn a startup entry on or off.
    ///
    /// Written the way Task Manager writes it: a twelve-byte value under `StartupApproved`
    /// whose first byte says enabled or not. The entry itself is not touched, so an operator
    /// can put back what they turned off — and WOLF has no code path that would remove one.
    /// </summary>
    public HelperStartupResult SetEnabled(string name, string scope, string source, bool enabled)
    {
        HelperStartupEntry? entry = List().Entries.FirstOrDefault(candidate =>
            string.Equals(candidate.Name, name, StringComparison.OrdinalIgnoreCase) &&
            candidate.Scope == scope &&
            candidate.Source == source);

        if (entry is null)
        {
            return new HelperStartupResult(
                name, scope, false, false, "unknown-entry",
                "There is no startup entry by that name on this PC.");
        }

        ServiceRefusal? refusal = AutorunProtection.CheckStartup(entry.Name, entry.Command, enabled);
        if (refusal is not null)
        {
            return new HelperStartupResult(name, scope, false, entry.Enabled, refusal.Code, refusal.Reason);
        }

        RegistryKey root = scope == "machine" ? Registry.LocalMachine : Registry.CurrentUser;
        string approvedPath = source == "startup-folder" ? ApprovedFolder : ApprovedRun;

        try
        {
            using RegistryKey key = root.CreateSubKey(approvedPath, writable: true);

            // Twelve bytes, and only the first one is read: 2 for enabled, 3 for disabled.
            // The remaining eight are a timestamp Windows writes and nothing reads back, so
            // they are left as zero rather than invented.
            var value = new byte[12];
            value[0] = enabled ? (byte)0x02 : (byte)0x03;
            key.SetValue(entry.Name, value, RegistryValueKind.Binary);

            _logger.LogInformation(
                "A {Scope} startup entry was {Action}.",
                scope,
                enabled ? "enabled" : "disabled");

            return new HelperStartupResult(entry.Name, scope, true, enabled, null, null);
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException
                                       or System.Security.SecurityException
                                       or IOException)
        {
            _logger.LogWarning(ex, "A startup entry could not be changed.");

            return new HelperStartupResult(
                entry.Name, scope, false, entry.Enabled, "failed",
                "Windows would not change that startup entry on this PC.");
        }
    }

    /// <summary>
    /// Whether Windows will actually run this entry.
    ///
    /// Absent means enabled: an entry nobody has ever switched off has no approval value at
    /// all, so treating a missing value as disabled would report every ordinary machine as
    /// having nothing that starts.
    /// </summary>
    private static bool IsApproved(RegistryKey? approved, string name)
    {
        if (approved?.GetValue(name) is not byte[] { Length: > 0 } value) return true;

        // 0x02 and 0x06 are both enabled in the wild; anything with the low bit set is
        // disabled. Reading only for 0x02 reports some enabled entries as off.
        return (value[0] & 0x01) == 0;
    }

    /// <summary>
    /// The users whose hives are mounted, which is to say the ones signed in.
    ///
    /// Service accounts are skipped by shape rather than by name: their SIDs are short and
    /// well-known, and the `_Classes` hives are a second mount of a hive already listed.
    /// </summary>
    private IEnumerable<(string Sid, string Label)> SignedInUsers()
    {
        string[] names;

        try
        {
            names = Registry.Users.GetSubKeyNames();
        }
        catch (Exception ex) when (ex is System.Security.SecurityException or UnauthorizedAccessException)
        {
            _logger.LogDebug(ex, "The mounted user hives could not be listed.");
            yield break;
        }

        foreach (string sid in names)
        {
            if (sid.EndsWith("_Classes", StringComparison.OrdinalIgnoreCase)) continue;

            // S-1-5-18/19/20 are LocalSystem, LocalService and NetworkService. They have
            // hives and no desktop, and listing their Run keys would be noise.
            if (!sid.StartsWith("S-1-5-21-", StringComparison.Ordinal)) continue;

            yield return (sid, ResolveName(sid));
        }
    }

    private static string ResolveName(string sid)
    {
        try
        {
            return new System.Security.Principal.SecurityIdentifier(sid)
                .Translate(typeof(System.Security.Principal.NTAccount))
                .Value;
        }
        catch (Exception ex) when (ex is System.Security.Principal.IdentityNotMappedException
                                       or ArgumentException
                                       or System.SystemException)
        {
            // A SID with no account behind it — a deleted user whose profile is still there.
            // Reported as the SID rather than dropped: it is still something that would run.
            return sid;
        }
    }

    private RegistryKey? OpenUserHive(string sid)
    {
        try
        {
            return Registry.Users.OpenSubKey(sid, writable: false);
        }
        catch (Exception ex) when (ex is System.Security.SecurityException or UnauthorizedAccessException)
        {
            _logger.LogDebug(ex, "A user hive could not be opened.");
            return null;
        }
    }
}
