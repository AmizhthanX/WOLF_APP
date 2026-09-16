using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging.Abstractions;
using Wolf.Agent.SessionHost.Files;
using Xunit;
using Xunit.Abstractions;

namespace Wolf.Agent.Core.Tests;

/// <summary>
/// Changing files over the data channel: rename, move, new folder, and delete — which is the Recycle Bin, checked
/// against this machine's actual Recycle Bin rather than taken on trust.
///
/// Real files in a temporary folder on this PC's fixed drive. Every test also checks what the cloud would be told:
/// the operation and its outcome, and never a path.
/// </summary>
public sealed class FileChangesTests : IDisposable
{
    private const string StreamId = "01J9ZQK7T0000000000000000B";
    private const string SessionId = "01J9ZQK7T0000000000000000A";
    private const string RequestId = "01J9ZQK7T0000000000000000R";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly ITestOutputHelper _output;
    private readonly string _root;
    private readonly string _registry;
    private readonly List<FileActivity> _reported = new();

    public FileChangesTests(ITestOutputHelper output)
    {
        _output = output;
        _root = Path.Combine(Path.GetTempPath(), $"wolf-changes-{Guid.NewGuid():N}");
        _registry = Path.Combine(Path.GetTempPath(), $"wolf-partials-{Guid.NewGuid():N}");
        Directory.CreateDirectory(_root);
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
            if (Directory.Exists(_registry)) Directory.Delete(_registry, recursive: true);
        }
        catch (IOException)
        {
        }
    }

    private FileChannel Channel(bool grant = true)
    {
        var channel = new FileChannel(StreamId, true, NullLoggerFactory.Instance, new PartialUploads(_registry, NullLogger.Instance), onActivity: _reported.Add);
        if (grant) channel.ApplyControl(true, SessionId, DateTimeOffset.UtcNow.AddMinutes(5));
        return channel;
    }

    private static JsonNode? Ask(FileChannel channel, string kind, object shape) =>
        channel.Handle(kind, JsonSerializer.SerializeToElement(shape, Json));

    private static string Kind(JsonNode? node) => node?["kind"]?.GetValue<string>() ?? "(none)";

    private static string Reason(JsonNode? node) => node?["reason"]?.GetValue<string>() ?? "(none)";

    private string Make(string name, string contents = "contents")
    {
        string path = Path.Combine(_root, name);
        File.WriteAllText(path, contents);
        return path;
    }

    /// <summary>Nothing the cloud is told names a file.</summary>
    private void NothingReportedNamesAPath()
    {
        foreach (FileActivity activity in _reported)
        {
            string said = JsonSerializer.Serialize(activity);
            _output.WriteLine(said);
            Assert.DoesNotContain(_root, said, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("\\", said, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void A_file_is_renamed_in_place_and_the_cloud_hears_only_that_a_rename_happened()
    {
        string path = Make("Quarterly draft.txt");
        FileChannel channel = Channel();

        JsonNode? done = Ask(channel, "file.rename", new { requestId = RequestId, path, newName = "Quarterly final.txt" });

        Assert.Equal("file.done", Kind(done));
        Assert.False(File.Exists(path));
        Assert.True(File.Exists(Path.Combine(_root, "Quarterly final.txt")));
        Assert.Equal(new FileActivity("rename", "completed", null, null), _reported.Single());
        NothingReportedNamesAPath();
    }

    [Fact]
    public void A_rename_never_replaces_what_is_there_but_a_change_of_case_is_allowed()
    {
        string path = Make("a.txt", "mine");
        Make("b.txt", "theirs");
        FileChannel channel = Channel();

        JsonNode? taken = Ask(channel, "file.rename", new { requestId = RequestId, path, newName = "b.txt" });
        Assert.Equal("exists", Reason(taken));
        Assert.Equal("theirs", File.ReadAllText(Path.Combine(_root, "b.txt")));

        JsonNode? cased = Ask(channel, "file.rename", new { requestId = RequestId, path, newName = "A.txt" });
        Assert.Equal("file.done", Kind(cased));
        Assert.Contains("A.txt", Directory.GetFiles(_root).Select(Path.GetFileName));

        Assert.Equal(new[] { "refused", "completed" }, _reported.Select(r => r.Outcome));
        Assert.Equal("exists", _reported[0].Reason);
    }

    [Theory]
    [InlineData("..")]
    [InlineData("sub\\name.txt")]
    [InlineData("a/b")]
    [InlineData("colon:stream")]
    [InlineData("ends with dot.")]
    [InlineData("ends with space ")]
    [InlineData("")]
    public void A_new_name_that_is_not_a_plain_name_is_refused(string newName)
    {
        string path = Make("keep.txt");
        JsonNode? refused = Ask(Channel(), "file.rename", new { requestId = RequestId, path, newName });

        Assert.Equal("rejected", Reason(refused));
        Assert.True(File.Exists(path));
    }

    [Fact]
    public void A_file_or_folder_moves_within_a_drive_and_never_into_itself_onto_a_name_or_into_Windows()
    {
        string file = Make("report.txt");
        string archive = Directory.CreateDirectory(Path.Combine(_root, "Archive")).FullName;
        string folder = Directory.CreateDirectory(Path.Combine(_root, "Projects")).FullName;
        string inner = Directory.CreateDirectory(Path.Combine(folder, "Inner")).FullName;
        FileChannel channel = Channel();

        Assert.Equal("file.done", Kind(Ask(channel, "file.move", new { requestId = RequestId, path = file, destinationFolder = archive })));
        Assert.True(File.Exists(Path.Combine(archive, "report.txt")));

        Assert.Equal("rejected", Reason(Ask(channel, "file.move", new { requestId = RequestId, path = folder, destinationFolder = inner })));

        Make("report.txt", "a second one");
        Assert.Equal("exists", Reason(Ask(channel, "file.move", new { requestId = RequestId, path = Path.Combine(_root, "report.txt"), destinationFolder = archive })));

        string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        Assert.Equal("rejected", Reason(Ask(channel, "file.move", new { requestId = RequestId, path = Path.Combine(_root, "report.txt"), destinationFolder = windows })));

        Assert.Equal("file.done", Kind(Ask(channel, "file.move", new { requestId = RequestId, path = folder, destinationFolder = archive })));
        Assert.True(Directory.Exists(Path.Combine(archive, "Projects", "Inner")));
        NothingReportedNamesAPath();
    }

    [Fact]
    public void A_folder_is_made_once_and_not_inside_Windows()
    {
        FileChannel channel = Channel();
        string path = Path.Combine(_root, "New folder");

        Assert.Equal("file.done", Kind(Ask(channel, "file.create-folder", new { requestId = RequestId, path })));
        Assert.True(Directory.Exists(path));
        Assert.Equal("exists", Reason(Ask(channel, "file.create-folder", new { requestId = RequestId, path })));

        string underWindows = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), $"wolf-{Guid.NewGuid():N}");
        Assert.Equal("rejected", Reason(Ask(channel, "file.create-folder", new { requestId = RequestId, path = underWindows })));
        Assert.False(Directory.Exists(underWindows));
    }

    [Fact]
    public void Windows_own_folders_a_drive_root_and_anything_without_the_lease_are_never_changed()
    {
        string path = Make("mine.txt");
        string systemFile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "notepad.exe");
        string drive = Path.GetPathRoot(_root)!;

        FileChannel channel = Channel();
        Assert.Equal("rejected", Reason(Ask(channel, "file.delete", new { requestId = RequestId, path = systemFile })));
        Assert.Equal("rejected", Reason(Ask(channel, "file.rename", new { requestId = RequestId, path = systemFile, newName = "x.exe" })));
        Assert.Equal("rejected", Reason(Ask(channel, "file.delete", new { requestId = RequestId, path = drive })));
        Assert.True(File.Exists(systemFile));

        FileChannel withoutLease = Channel(grant: false);
        Assert.Equal("not-permitted", Reason(Ask(withoutLease, "file.delete", new { requestId = RequestId, path })));
        Assert.True(File.Exists(path));
    }

    [Fact]
    public void Something_an_upload_is_writing_is_not_moved_or_deleted_under_it()
    {
        string destination = Path.Combine(_root, "incoming.bin");
        FileChannel channel = Channel();
        byte[] chunk = new byte[16];
        Ask(channel, "file.write", new
        {
            requestId = RequestId,
            transferId = "01J9ZQK7T0000000000000000X",
            path = destination,
            offset = 0,
            data = Convert.ToBase64String(chunk),
            sha256 = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(chunk)),
            final = false,
            totalBytes = 1000,
        });

        Assert.Equal("rejected", Reason(Ask(channel, "file.delete", new { requestId = RequestId, path = destination + FileChannel.PartSuffix })));
        Assert.Equal("rejected", Reason(Ask(channel, "file.delete", new { requestId = RequestId, path = _root })));
        channel.Dispose();
    }

    [Fact]
    public void A_delete_goes_to_this_PCs_Recycle_Bin_not_away_for_good()
    {
        string name = $"wolf-recycle-test-{Guid.NewGuid():N}.txt";
        string path = Make(name, "put me back");
        FileChannel channel = Channel();

        JsonNode? done = Ask(channel, "file.delete", new { requestId = RequestId, path });

        Assert.Equal("file.done", Kind(done));
        Assert.False(File.Exists(path));
        Assert.Equal(new FileActivity("delete", "completed", null, null), _reported.Single());

        // The Recycle Bin keeps, for each item, a small $I file holding the path it came from. Finding ours there is
        // the proof it can be restored; the test then removes its own item from the bin.
        string sid = WindowsIdentity.GetCurrent().User!.Value;
        string bin = Path.Combine(Path.GetPathRoot(path)!, "$Recycle.Bin", sid);
        string[] records = Directory.GetFiles(bin, "$I*");
        string? ours = records.FirstOrDefault(record =>
        {
            try
            {
                return Encoding.Unicode.GetString(File.ReadAllBytes(record)).Contains(path, StringComparison.OrdinalIgnoreCase);
            }
            catch (IOException)
            {
                return false;
            }
        });

        _output.WriteLine($"found in the Recycle Bin: {ours is not null}");
        Assert.NotNull(ours);

        string item = Path.Combine(bin, "$R" + Path.GetFileName(ours)![2..]);
        Assert.Equal("put me back", File.ReadAllText(item));
        File.Delete(item);
        File.Delete(ours);
    }
}
