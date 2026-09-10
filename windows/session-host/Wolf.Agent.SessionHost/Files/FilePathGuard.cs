using System.Runtime.Versioning;

namespace Wolf.Agent.SessionHost.Files;

/// <summary>What the guard decided about a path, and why.</summary>
public sealed record PathVerdict(
    bool Ok,
    string? Normalized,
    string Reason,
    string Detail,
    bool Limitation = false)
{
    public static PathVerdict Allow(string normalized) => new(true, normalized, "ok", string.Empty);

    public static PathVerdict Refuse(string reason, string detail, bool limitation = false) =>
        new(false, null, reason, detail, limitation);
}

/// <summary>
/// The gate every file path passes before anything touches a disk.
///
/// Two halves, and the split is not cosmetic. <see cref="Check"/> is arithmetic on a string
/// and can be tested exhaustively; <see cref="Resolve"/> has to touch the filesystem, because
/// whether a path is a junction pointing somewhere else is not a question a string can
/// answer. Passing the first is never authorisation to act — it is permission to ask the
/// second.
///
/// This mirrors `packages/validation/src/windows-path.ts`, which guards the same paths on the
/// command path. Two implementations of one rule set is a real cost, and the alternative —
/// letting the agent trust a check the cloud performed — is worse: file traffic never goes
/// through the cloud, so on this path nothing upstream has looked at these strings at all.
///
/// **What the operator's own account allows is enforced by Windows, not here.** The session
/// host runs as the signed-in user, so a folder they cannot read is a folder WOLF cannot read,
/// with no extra code and no way to get it wrong. What this class stops is the narrower set
/// of tricks that make one path *look* like another.
/// </summary>
[SupportedOSPlatform("windows")]
public static class FilePathGuard
{
    /// <summary>Well below Windows' long-path limit, and the same cap the cloud uses.</summary>
    public const int MaxPathLength = 4096;

    /// <summary>
    /// Names Windows resolves to a device rather than a file, whatever the extension.
    ///
    /// `C:\temp\CON.txt` is not a file called CON.txt. Opening it talks to the console
    /// device, and on the wrong API that is a hang rather than an error.
    /// </summary>
    private static readonly HashSet<string> ReservedNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    };

    private static readonly System.Buffers.SearchValues<char> Wildcards =
        System.Buffers.SearchValues.Create("*?");

    /// <summary>Roots that belong to Windows. Flagged to the operator, never silently refused.</summary>
    private static readonly string[] ProtectedPrefixes =
    {
        @"\WINDOWS",
        @"\PROGRAM FILES",
        @"\PROGRAM FILES (X86)",
        @"\PROGRAMDATA",
        @"\SYSTEM VOLUME INFORMATION",
        @"\$RECYCLE.BIN",
        @"\RECOVERY",
        @"\BOOT",
        @"\EFI",
    };

    /// <summary>
    /// Whether a path is syntactically one WOLF will consider.
    ///
    /// Every refusal here is a shape that means something other than it looks like.
    /// </summary>
    public static PathVerdict Check(string? input)
    {
        if (string.IsNullOrWhiteSpace(input))
        {
            return PathVerdict.Refuse("rejected", "A path is required.");
        }

        if (input.Length > MaxPathLength)
        {
            return PathVerdict.Refuse("rejected", "That path is longer than WOLF accepts.");
        }

        foreach (char character in input)
        {
            if (character < ' ')
            {
                return PathVerdict.Refuse("rejected", "A path must not contain control characters.");
            }
        }

        string unified = input.Replace('/', '\\');

        // Checked before the wildcard rule, because `\\?\` contains a `?` and reporting it as
        // a stray wildcard would hide the real reason it was refused. These prefixes exist
        // precisely to bypass the normalisation everything below relies on.
        if (unified.StartsWith(@"\\?\", StringComparison.Ordinal) ||
            unified.StartsWith(@"\\.\", StringComparison.Ordinal))
        {
            return PathVerdict.Refuse(
                "rejected",
                "Extended-length and device-namespace paths are not accepted, because they bypass the checks that make a path mean what it says.");
        }

        // A network path is a decision rather than an oversight. The session host holds the
        // signed-in user's credentials, so browsing `\\fileserver\finance` from a remote
        // session would let WOLF be used to reach machines that are not the one the operator
        // was granted — with that user's rights and none of WOLF's audit trail on the far end.
        if (unified.StartsWith(@"\\", StringComparison.Ordinal))
        {
            return PathVerdict.Refuse(
                "unsupported",
                "WOLF browses this PC's own disks. Network locations are not reachable through it.");
        }

        if (unified.AsSpan().IndexOfAny(Wildcards) >= 0)
        {
            return PathVerdict.Refuse("rejected", "A path must not contain wildcards.");
        }

        // Absolute, drive-letter, and nothing else. A relative path has no meaning here —
        // there is no working directory a client and a session host would agree on.
        if (unified.Length < 3 ||
            !char.IsAsciiLetter(unified[0]) ||
            unified[1] != ':' ||
            unified[2] != '\\')
        {
            return PathVerdict.Refuse("rejected", "A path must be an absolute path on a drive, such as C:\\Users.");
        }

        string remainder = unified[3..];

        // A colon past the drive letter opens an alternate data stream — a second, hidden
        // body of content on the same file. `notes.txt:secret` is not `notes.txt`.
        if (remainder.Contains(':', StringComparison.Ordinal))
        {
            return PathVerdict.Refuse(
                "rejected",
                "A path must not name an alternate data stream.");
        }

        foreach (string segment in remainder.Split('\\', StringSplitOptions.None))
        {
            if (segment.Length == 0) continue;

            if (segment == "." || segment == "..")
            {
                return PathVerdict.Refuse("rejected", "A path must not contain relative segments.");
            }

            // Windows strips these silently, which makes `evil.exe.` and `evil.exe` the same
            // file and different strings — the classic way past a check that compares names.
            if (segment[^1] == '.' || segment[^1] == ' ')
            {
                return PathVerdict.Refuse(
                    "rejected",
                    "A path segment must not end with a dot or a space.");
            }

            string bare = segment.Split('.')[0];
            if (ReservedNames.Contains(bare))
            {
                return PathVerdict.Refuse(
                    "rejected",
                    $"'{segment}' is a reserved Windows device name, not a file.");
            }
        }

        string normalized = char.ToUpperInvariant(unified[0]) + unified[1..];

        // A trailing separator is dropped so two spellings of one directory compare equal —
        // except at a drive root, where `C:\` is the path and `C:` is something else entirely.
        if (normalized.Length > 3 && normalized[^1] == '\\')
        {
            normalized = normalized[..^1];
        }

        return PathVerdict.Allow(normalized);
    }

    /// <summary>Whether a normalised path sits under a Windows-owned root.</summary>
    public static bool IsProtected(string normalized)
    {
        string withoutDrive = normalized.Length >= 2 ? normalized[2..] : normalized;

        foreach (string prefix in ProtectedPrefixes)
        {
            if (withoutDrive.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) &&
                (withoutDrive.Length == prefix.Length || withoutDrive[prefix.Length] == '\\'))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// The second gate: what this path actually is on the disk.
    ///
    /// A junction or symlink is a path that passed every string check and points somewhere
    /// else — `C:\Users\Public\shortcut` resolving into `C:\Windows\System32` is not something
    /// syntax can catch. The target is resolved and put back through <see cref="Check"/>, so a
    /// link out of the rules is refused by the same rules.
    /// </summary>
    /// <param name="mustExist">
    /// False when the caller is about to create the file. An upload destination that does not
    /// exist yet is the normal case, and refusing it would make writing anything impossible.
    /// </param>
    public static PathVerdict Resolve(string? input, bool mustExist = true)
    {
        PathVerdict syntax = Check(input);
        if (!syntax.Ok) return syntax;

        string path = syntax.Normalized!;

        try
        {
            FileSystemInfo? info = Directory.Exists(path)
                ? new DirectoryInfo(path)
                : File.Exists(path)
                    ? new FileInfo(path)
                    : null;

            if (info is null)
            {
                if (mustExist)
                {
                    return PathVerdict.Refuse("not-found", "There is nothing at that path on this PC.");
                }

                // Creating something: the parent has to exist and has to survive the same
                // checks, because a link in the parent redirects the child just as well.
                string? parent = Path.GetDirectoryName(path);
                if (parent is null) return PathVerdict.Refuse("rejected", "That path has no parent directory.");
                if (!Directory.Exists(parent))
                {
                    return PathVerdict.Refuse("not-found", "The folder that path is in does not exist.");
                }

                PathVerdict parentVerdict = Resolve(parent);
                if (!parentVerdict.Ok) return parentVerdict;

                return PathVerdict.Allow(Path.Combine(parentVerdict.Normalized!, Path.GetFileName(path)));
            }

            if (info.Attributes.HasFlag(FileAttributes.ReparsePoint))
            {
                FileSystemInfo? target = info.ResolveLinkTarget(returnFinalTarget: true);

                if (target is null)
                {
                    return PathVerdict.Refuse(
                        "rejected",
                        "That path is a link WOLF could not follow to a real location.");
                }

                // The target goes through the whole gate again. A link is only ever as
                // acceptable as the place it points.
                return Resolve(target.FullName, mustExist);
            }

            return PathVerdict.Allow(path);
        }
        catch (UnauthorizedAccessException)
        {
            // Windows saying no, which is a different thing from WOLF saying no, and the
            // operator's next step is different for each.
            return PathVerdict.Refuse(
                "access-denied",
                "The account WOLF is running as cannot open that path on this PC.",
                limitation: true);
        }
        catch (Exception ex) when (ex is IOException or ArgumentException or NotSupportedException)
        {
            return PathVerdict.Refuse("rejected", "That path could not be read on this PC.");
        }
    }
}
