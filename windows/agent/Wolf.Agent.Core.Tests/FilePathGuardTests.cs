using Wolf.Agent.SessionHost.Files;
using Xunit;
using Xunit.Abstractions;

namespace Wolf.Agent.Core.Tests;

/// <summary>
/// The gate every file path passes before anything touches a disk.
///
/// Worth testing exhaustively because each refusal is a shape that means something other than
/// it looks like, and every one of them is a real Windows behaviour rather than a
/// hypothetical: `evil.exe.` and `evil.exe` really are the same file, `CON.txt` really does
/// talk to a device, and a junction really does move a path somewhere else after every string
/// check has passed.
///
/// What is *not* here is the account's own permissions. The session host runs as the signed-in
/// user, so a folder they cannot read is a folder WOLF cannot read — enforced by Windows, with
/// no code to get wrong. This class covers the narrower job of stopping one path from
/// impersonating another.
/// </summary>
public sealed class FilePathGuardTests
{
    private readonly ITestOutputHelper _output;

    public FilePathGuardTests(ITestOutputHelper output)
    {
        _output = output;
    }

    /* --------------------------------------------------------------------- */
    /* What is allowed                                                        */
    /* --------------------------------------------------------------------- */

    [Theory]
    [InlineData(@"C:\Users\operator\Documents", @"C:\Users\operator\Documents")]
    [InlineData(@"c:\users", @"C:\users")]
    [InlineData(@"C:/Users/operator", @"C:\Users\operator")]
    [InlineData(@"C:\Users\operator\", @"C:\Users\operator")]
    [InlineData(@"C:\", @"C:\")]
    [InlineData(@"D:\data\report 2026.xlsx", @"D:\data\report 2026.xlsx")]
    public void An_ordinary_path_is_accepted_and_normalised(string input, string expected)
    {
        PathVerdict verdict = FilePathGuard.Check(input);

        _output.WriteLine($"{input} -> {verdict.Normalized ?? verdict.Reason}");

        Assert.True(verdict.Ok, verdict.Detail);

        // Normalised so two spellings of one directory compare equal — except at a drive
        // root, where `C:\` is the path and `C:` is something else entirely.
        Assert.Equal(expected, verdict.Normalized);
    }

    /* --------------------------------------------------------------------- */
    /* Paths that mean something other than they look like                    */
    /* --------------------------------------------------------------------- */

    [Theory]
    [InlineData(@"C:\Users\..\Windows\System32", "climbing out with ..")]
    [InlineData(@"C:\Users\.\operator", "a . segment")]
    [InlineData(@"C:\Users\operator\..\..\Windows", "climbing out twice")]
    public void A_relative_segment_is_refused_rather_than_collapsed(string path, string description)
    {
        PathVerdict verdict = FilePathGuard.Check(path);

        _output.WriteLine($"{description}: {verdict.Reason} — {verdict.Detail}");

        // Refused rather than resolved. Collapsing it here would mean the path WOLF checked
        // and the path WOLF opened were produced by two different pieces of code, which is
        // the gap every traversal bug lives in.
        Assert.False(verdict.Ok);
        Assert.Equal("rejected", verdict.Reason);
    }

    [Theory]
    [InlineData(@"\\?\C:\Windows\System32", "the extended-length prefix")]
    [InlineData(@"\\.\PhysicalDrive0", "the device namespace")]
    [InlineData(@"\\.\C:", "a drive as a device")]
    public void A_device_namespace_path_is_refused(string path, string description)
    {
        PathVerdict verdict = FilePathGuard.Check(path);

        _output.WriteLine($"{description}: {verdict.Detail}");

        // These prefixes exist precisely to bypass the normalisation every rule below relies
        // on. `\\?\C:\evil.exe.` is a real file with a real trailing dot.
        Assert.False(verdict.Ok);
        Assert.Equal("rejected", verdict.Reason);
    }

    [Theory]
    [InlineData(@"\\fileserver\finance")]
    [InlineData(@"\\10.0.0.5\c$")]
    public void A_network_path_is_refused_as_unsupported_rather_than_broken(string path)
    {
        PathVerdict verdict = FilePathGuard.Check(path);

        _output.WriteLine(verdict.Detail);

        // A decision rather than an oversight, and reported as one. The session host holds
        // the signed-in user's credentials, so browsing a share from a remote session would
        // let WOLF reach machines the operator was never granted — with that user's rights
        // and none of WOLF's audit trail on the far end.
        Assert.False(verdict.Ok);
        Assert.Equal("unsupported", verdict.Reason);
    }

    [Theory]
    [InlineData(@"C:\temp\CON")]
    [InlineData(@"C:\temp\CON.txt")]
    [InlineData(@"C:\temp\nul.log")]
    [InlineData(@"C:\temp\COM1")]
    [InlineData(@"C:\temp\LPT9.dat")]
    public void A_reserved_device_name_is_refused_whatever_the_extension(string path)
    {
        PathVerdict verdict = FilePathGuard.Check(path);

        // `C:\temp\CON.txt` is not a file called CON.txt. Opening it talks to the console
        // device, and on the wrong API that is a hang rather than an error.
        Assert.False(verdict.Ok);
        Assert.Equal("rejected", verdict.Reason);
    }

    [Theory]
    [InlineData(@"C:\temp\evil.exe.", "a trailing dot")]
    [InlineData(@"C:\temp\evil.exe ", "a trailing space")]
    [InlineData(@"C:\temp\folder.\file.txt", "a trailing dot mid-path")]
    public void A_trailing_dot_or_space_is_refused(string path, string description)
    {
        PathVerdict verdict = FilePathGuard.Check(path);

        _output.WriteLine($"{description}: {verdict.Detail}");

        // Windows strips these silently, which makes `evil.exe.` and `evil.exe` the same file
        // and different strings — the classic way past a check that compares names.
        Assert.False(verdict.Ok);
        Assert.Equal("rejected", verdict.Reason);
    }

    [Theory]
    [InlineData(@"C:\notes.txt:hidden")]
    [InlineData(@"C:\Users\operator\file.txt:$DATA")]
    public void An_alternate_data_stream_is_refused(string path)
    {
        PathVerdict verdict = FilePathGuard.Check(path);

        // A second, hidden body of content on the same file. `notes.txt:secret` is not
        // `notes.txt`, and a transfer of one is not a transfer of the other.
        Assert.False(verdict.Ok);
        Assert.Equal("rejected", verdict.Reason);
    }

    [Theory]
    [InlineData(@"C:\Users\*", "a wildcard")]
    [InlineData(@"C:\Users\?", "a single-character wildcard")]
    [InlineData("Users\\operator", "a relative path")]
    [InlineData(@"\Users\operator", "a rooted path with no drive")]
    [InlineData("", "nothing at all")]
    [InlineData("   ", "whitespace")]
    [InlineData("C:\\Users\\op\u0000erator", "an embedded null")]
    [InlineData("C:\\Users\\op\nerator", "an embedded newline")]
    public void Anything_that_is_not_an_absolute_drive_path_is_refused(string path, string description)
    {
        PathVerdict verdict = FilePathGuard.Check(path);

        _output.WriteLine($"{description}: {verdict.Reason}");

        Assert.False(verdict.Ok);
    }

    [Fact]
    public void A_path_longer_than_WOLF_accepts_is_refused_rather_than_truncated()
    {
        string path = @"C:\" + new string('a', FilePathGuard.MaxPathLength);

        PathVerdict verdict = FilePathGuard.Check(path);

        // Truncating would produce a valid path to a different place, which is worse than a
        // refusal by exactly the amount that matters.
        Assert.False(verdict.Ok);
        Assert.Equal("rejected", verdict.Reason);
    }

    /* --------------------------------------------------------------------- */
    /* Windows' own folders                                                   */
    /* --------------------------------------------------------------------- */

    [Theory]
    [InlineData(@"C:\Windows\System32", true)]
    [InlineData(@"C:\WINDOWS", true)]
    [InlineData(@"C:\Program Files\WOLF", true)]
    [InlineData(@"C:\ProgramData\WOLF", true)]
    [InlineData(@"D:\Windows\System32", true)]
    [InlineData(@"C:\Users\operator\Documents", false)]
    [InlineData(@"C:\WindowsApps-personal\notes.txt", false)]
    public void A_protected_location_is_recognised_without_being_refused(string path, bool expected)
    {
        // Flagged, not blocked. An operator may perfectly well want to fetch a log from
        // `C:\Windows\Logs`; what they must not do is write into it by accident, and that is
        // a decision for the caller rather than for the path.
        Assert.Equal(expected, FilePathGuard.IsProtected(path));
    }

    [Fact]
    public void A_prefix_match_does_not_swallow_a_longer_name()
    {
        // `C:\WindowsApps-personal` is not inside `C:\Windows`, and treating it as protected
        // would refuse writes to somebody's own folder for the rest of the product's life.
        Assert.False(FilePathGuard.IsProtected(@"C:\WindowsApps-personal"));
        Assert.True(FilePathGuard.IsProtected(@"C:\Windows"));
        Assert.True(FilePathGuard.IsProtected(@"C:\Windows\Logs\CBS"));
    }

    /* --------------------------------------------------------------------- */
    /* The second gate, against a real filesystem                             */
    /* --------------------------------------------------------------------- */

    [Fact]
    public void A_path_that_exists_resolves_to_itself()
    {
        string temp = Path.Combine(Path.GetTempPath(), $"wolf-guard-{Guid.NewGuid():N}");
        Directory.CreateDirectory(temp);

        try
        {
            PathVerdict verdict = FilePathGuard.Resolve(temp);

            _output.WriteLine($"{temp} -> {verdict.Normalized ?? verdict.Reason}");

            Assert.True(verdict.Ok, verdict.Detail);
            Assert.Equal(FilePathGuard.Check(temp).Normalized, verdict.Normalized);
        }
        finally
        {
            Directory.Delete(temp, recursive: true);
        }
    }

    [Fact]
    public void A_path_that_does_not_exist_is_reported_as_missing_rather_than_rejected()
    {
        PathVerdict verdict = FilePathGuard.Resolve(
            Path.Combine(Path.GetTempPath(), $"wolf-not-here-{Guid.NewGuid():N}", "file.txt"));

        // The distinction matters to whoever reads it: "WOLF will not touch that" and "there
        // is nothing there" call for different next steps.
        Assert.False(verdict.Ok);
        Assert.Equal("not-found", verdict.Reason);
    }

    [Fact]
    public void A_destination_that_does_not_exist_yet_is_allowed_when_its_folder_does()
    {
        string temp = Path.Combine(Path.GetTempPath(), $"wolf-guard-{Guid.NewGuid():N}");
        Directory.CreateDirectory(temp);

        try
        {
            // The normal case for an upload, and refusing it would make writing anything
            // impossible. The *parent* still goes through the whole gate, because a link in
            // the parent redirects the child just as well.
            PathVerdict verdict = FilePathGuard.Resolve(Path.Combine(temp, "new.txt"), mustExist: false);

            Assert.True(verdict.Ok, verdict.Detail);
            Assert.EndsWith("new.txt", verdict.Normalized!, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(temp, recursive: true);
        }
    }

    [Fact]
    public void A_junction_is_followed_and_the_target_is_what_gets_checked()
    {
        string root = Path.Combine(Path.GetTempPath(), $"wolf-guard-{Guid.NewGuid():N}");
        string real = Path.Combine(root, "real");
        string link = Path.Combine(root, "link");

        Directory.CreateDirectory(real);
        File.WriteAllText(Path.Combine(real, "inside.txt"), "x");

        try
        {
            Directory.CreateSymbolicLink(link, real);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Creating a symlink needs developer mode or administrator. Saying so beats a
            // test that silently proves nothing.
            _output.WriteLine(
                "Symbolic links cannot be created by this account; the resolution path is not exercised here.");
            Directory.Delete(root, recursive: true);
            return;
        }

        try
        {
            PathVerdict verdict = FilePathGuard.Resolve(link);

            _output.WriteLine($"{link} -> {verdict.Normalized}");

            // The whole point of the second gate. A link is a path that passed every string
            // check and points somewhere else, and it is only ever as acceptable as its
            // target — so the target goes back through the same rules.
            Assert.True(verdict.Ok, verdict.Detail);
            Assert.Equal(
                FilePathGuard.Check(real).Normalized,
                verdict.Normalized,
                ignoreCase: true);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void A_string_check_is_never_taken_as_permission_to_act()
    {
        // States the contract as a test rather than only as a comment. `Check` says a path is
        // a shape WOLF will consider; only `Resolve` says anything about what is there.
        string missing = Path.Combine(Path.GetTempPath(), $"wolf-nope-{Guid.NewGuid():N}.txt");

        Assert.True(FilePathGuard.Check(missing).Ok);
        Assert.False(FilePathGuard.Resolve(missing).Ok);
    }
}
