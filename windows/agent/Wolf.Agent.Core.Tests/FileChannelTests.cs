using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Wolf.Agent.SessionHost.Files;
using Xunit;
using Xunit.Abstractions;

namespace Wolf.Agent.Core.Tests;

/// <summary>
/// Browsing a PC's disks, and moving files across the data channel.
///
/// Real files on a real disk. A mock filesystem would prove the message handling calls itself
/// in the right order and nothing about whether a resumed upload lands the same bytes, which
/// is the only question that matters for a transfer.
///
/// Most of these are about the gate rather than the plumbing. File traffic arrives straight
/// from the browser, nothing upstream has looked at it, and a file manager is the feature
/// where "it mostly works" and "it silently gave somebody the wrong file" look identical from
/// the outside.
/// </summary>
public sealed class FileChannelTests : IDisposable
{
    private readonly ITestOutputHelper _output;
    private readonly string _root;

    public FileChannelTests(ITestOutputHelper output)
    {
        _output = output;
        _root = Path.Combine(Path.GetTempPath(), $"wolf-files-{Guid.NewGuid():N}");
        Directory.CreateDirectory(_root);
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
        }
        catch (IOException)
        {
            // A test that left a handle open. Not worth failing the run over a temp folder.
        }
    }

    private const string StreamId = "01J9ZQK7T0000000000000000B";
    private const string SessionId = "01J9ZQK7T0000000000000000A";
    private const string RequestId = "01J9ZQK7T0000000000000000R";
    private const string TransferId = "01J9ZQK7T0000000000000000X";

    private static FileChannel Channel(bool allowed = true, ILoggerFactory? loggers = null) =>
        new(StreamId, allowed, loggers ?? NullLoggerFactory.Instance);

    private static void Grant(FileChannel channel, int seconds = 300) =>
        channel.ApplyControl(true, SessionId, DateTimeOffset.UtcNow.AddSeconds(seconds));

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private static JsonElement Message(object shape) => JsonSerializer.SerializeToElement(shape, Json);

    private static string Kind(JsonNode? node) => node?["kind"]?.GetValue<string>() ?? "(none)";

    private static string Reason(JsonNode? node) => node?["reason"]?.GetValue<string>() ?? "(none)";

    private static string Sha(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));

    private string File(string name, byte[] contents)
    {
        string path = Path.Combine(_root, name);
        System.IO.File.WriteAllBytes(path, contents);
        return path;
    }

    /* --------------------------------------------------------------------- */
    /* The gate                                                               */
    /* --------------------------------------------------------------------- */

    [Fact]
    public void A_session_that_was_not_granted_files_cannot_browse_anything()
    {
        FileChannel channel = Channel(allowed: false);

        // Granted the lease and still refused, which is the point: the lease arbitrates
        // between sessions that may touch files. This one may not.
        Grant(channel);

        JsonNode? refused = channel.Handle("file.list", Message(new { requestId = RequestId, path = _root }));

        _output.WriteLine(refused?.ToJsonString());

        Assert.Equal("file.refused", Kind(refused));
        Assert.Equal("not-permitted", Reason(refused));
    }

    [Fact]
    public void A_session_with_the_capability_but_no_lease_cannot_browse_anything()
    {
        FileChannel channel = Channel();

        // The default is no. Being allowed files is not the same as holding them, and a
        // session that was first to open a data channel must not get the disks for it.
        Assert.False(channel.HasControl);
        Assert.Equal("not-permitted", Reason(channel.Handle("file.list", Message(new { requestId = RequestId, path = _root }))));
    }

    [Fact]
    public void An_expired_lease_cannot_browse_anything()
    {
        FileChannel channel = Channel();
        channel.ApplyControl(true, SessionId, DateTimeOffset.UtcNow.AddSeconds(-1));

        // The case the expiry exists for: the cloud became unreachable. Nothing arrived to
        // revoke this, and it lapses anyway.
        Assert.False(channel.HasControl);
        Assert.Equal("not-permitted", Reason(channel.Handle("file.read", Message(new
        {
            requestId = RequestId,
            path = File("x.txt", "hello"u8.ToArray()),
            offset = 0,
            length = 16,
        }))));
    }

    [Theory]
    [InlineData(@"C:\Users\..\Windows\System32", "climbing out")]
    [InlineData(@"\\?\C:\Windows", "the extended-length prefix")]
    [InlineData(@"\\fileserver\share", "a network path")]
    [InlineData(@"C:\temp\CON.txt", "a device name")]
    [InlineData(@"C:\notes.txt:hidden", "an alternate data stream")]
    public void A_path_the_guard_refuses_never_reaches_the_disk(string path, string description)
    {
        FileChannel channel = Channel();
        Grant(channel);

        JsonNode? refused = channel.Handle("file.list", Message(new { requestId = RequestId, path }));

        _output.WriteLine($"{description}: {Reason(refused)}");

        // The gate runs before anything is opened, so a path that means something other than
        // it looks like never becomes a handle.
        Assert.Equal("file.refused", Kind(refused));
        Assert.Contains(Reason(refused), new[] { "rejected", "unsupported" });
    }

    /* --------------------------------------------------------------------- */
    /* Browsing                                                               */
    /* --------------------------------------------------------------------- */

    [Fact]
    public void A_directory_lists_what_is_in_it()
    {
        File("report.txt", "hello"u8.ToArray());
        Directory.CreateDirectory(Path.Combine(_root, "nested"));

        FileChannel channel = Channel();
        Grant(channel);

        JsonNode? listing = channel.Handle("file.list", Message(new { requestId = RequestId, path = _root }));

        Assert.Equal("file.listing", Kind(listing));

        JsonArray entries = listing!["entries"]!.AsArray();
        _output.WriteLine(listing.ToJsonString());

        Assert.Equal(2, entries.Count);
        Assert.Contains(entries, e => e!["name"]!.GetValue<string>() == "report.txt" &&
                                      e["kind"]!.GetValue<string>() == "file" &&
                                      e["sizeBytes"]!.GetValue<long>() == 5);
        Assert.Contains(entries, e => e!["name"]!.GetValue<string>() == "nested" &&
                                      e["kind"]!.GetValue<string>() == "directory");
        Assert.False(listing["truncated"]!.GetValue<bool>());
    }

    [Fact]
    public void A_directory_bigger_than_WOLF_lists_says_it_was_truncated()
    {
        string big = Path.Combine(_root, "big");
        Directory.CreateDirectory(big);

        for (int index = 0; index <= FileChannel.MaxEntries; index++)
        {
            System.IO.File.WriteAllText(Path.Combine(big, $"f{index}.txt"), "x");
        }

        FileChannel channel = Channel();
        Grant(channel);

        JsonNode? listing = channel.Handle("file.list", Message(new { requestId = RequestId, path = big }));

        // Said rather than silently cut. A folder that shows 2000 of its 40000 files with no
        // indication is one an operator concludes does not contain what they are looking for.
        Assert.True(listing!["truncated"]!.GetValue<bool>());
        Assert.Equal(FileChannel.MaxEntries, listing["entries"]!.AsArray().Count);
    }

    [Fact]
    public void Listing_with_no_path_gives_the_drives()
    {
        FileChannel channel = Channel();
        Grant(channel);

        JsonNode? listing = channel.Handle("file.list", Message(new { requestId = RequestId, path = (string?)null }));

        Assert.Equal("file.listing", Kind(listing));
        Assert.Null(listing!["path"]?.GetValue<string?>());

        JsonArray drives = listing["entries"]!.AsArray();
        _output.WriteLine(string.Join(", ", drives.Select(d => d!["name"]!.GetValue<string>())));

        // Every Windows machine has at least one fixed drive. A machine that reported none
        // would be one where the file manager silently has no root.
        Assert.NotEmpty(drives);
        Assert.All(drives, drive => Assert.Equal("drive", drive!["kind"]!.GetValue<string>()));
    }

    [Fact]
    public void A_file_is_not_a_folder_and_says_so()
    {
        string path = File("report.txt", "hello"u8.ToArray());

        FileChannel channel = Channel();
        Grant(channel);

        Assert.Equal("rejected", Reason(channel.Handle("file.list", Message(new { requestId = RequestId, path }))));
    }

    /* --------------------------------------------------------------------- */
    /* Reading                                                                */
    /* --------------------------------------------------------------------- */

    [Fact]
    public void A_file_comes_back_in_chunks_that_reassemble_into_it()
    {
        // Not a round number of chunks, so an off-by-one at the end has somewhere to show.
        var contents = new byte[(FileChannel.MaxChunkBytes * 2) + 1234];
        new Random(20260910).NextBytes(contents);
        string path = File("payload.bin", contents);

        FileChannel channel = Channel();
        Grant(channel);

        var assembled = new List<byte>();
        long offset = 0;
        bool eof = false;
        int chunks = 0;

        while (!eof)
        {
            JsonNode? chunk = channel.Handle("file.read", Message(new
            {
                requestId = RequestId,
                path,
                offset,
                length = FileChannel.MaxChunkBytes,
            }));

            Assert.Equal("file.chunk", Kind(chunk));

            byte[] bytes = Convert.FromBase64String(chunk!["data"]!.GetValue<string>());

            // Per chunk, so a byte that arrives wrong is caught where it happened rather than
            // as a file that turns out to be broken a week later.
            Assert.Equal(Sha(bytes), chunk["sha256"]!.GetValue<string>());
            Assert.Equal(contents.Length, chunk["totalBytes"]!.GetValue<long>());

            assembled.AddRange(bytes);
            offset += bytes.Length;
            eof = chunk["eof"]!.GetValue<bool>();
            chunks++;
        }

        _output.WriteLine($"{contents.Length} bytes in {chunks} chunk(s)");

        Assert.Equal(3, chunks);
        Assert.Equal(contents, assembled.ToArray());
    }

    [Fact]
    public void A_read_can_start_anywhere_which_is_what_makes_it_resumable()
    {
        var contents = new byte[5000];
        new Random(7).NextBytes(contents);
        string path = File("payload.bin", contents);

        FileChannel channel = Channel();
        Grant(channel);

        JsonNode? chunk = channel.Handle("file.read", Message(new
        {
            requestId = RequestId,
            path,
            offset = 4000,
            length = FileChannel.MaxChunkBytes,
        }));

        byte[] bytes = Convert.FromBase64String(chunk!["data"]!.GetValue<string>());

        // The client asks for the offset it wants. A push-based stream would be fewer
        // messages and would lose its place on every reconnect, which on a data channel over
        // somebody's home internet is not an edge case.
        Assert.Equal(1000, bytes.Length);
        Assert.Equal(contents[4000..], bytes);
        Assert.True(chunk["eof"]!.GetValue<bool>());
    }

    [Fact]
    public void An_offset_past_the_end_is_refused_rather_than_answered_with_nothing()
    {
        string path = File("small.txt", "hello"u8.ToArray());

        FileChannel channel = Channel();
        Grant(channel);

        JsonNode? refused = channel.Handle("file.read", Message(new
        {
            requestId = RequestId,
            path,
            offset = 500,
            length = 16,
        }));

        // An empty chunk would read as "the file ended here", and a client resuming a
        // transfer would write a truncated file and believe it was complete.
        Assert.Equal("rejected", Reason(refused));
    }

    [Fact]
    public void A_read_larger_than_a_chunk_is_refused()
    {
        string path = File("small.txt", "hello"u8.ToArray());

        FileChannel channel = Channel();
        Grant(channel);

        Assert.Equal("rejected", Reason(channel.Handle("file.read", Message(new
        {
            requestId = RequestId,
            path,
            offset = 0,
            length = FileChannel.MaxChunkBytes + 1,
        }))));
    }

    [Fact]
    public void A_file_being_written_by_something_else_can_still_be_fetched()
    {
        string path = Path.Combine(_root, "live.log");

        using var writer = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.ReadWrite);
        writer.Write("first line\n"u8);
        writer.Flush();

        FileChannel channel = Channel();
        Grant(channel);

        JsonNode? chunk = channel.Handle("file.read", Message(new
        {
            requestId = RequestId,
            path,
            offset = 0,
            length = FileChannel.MaxChunkBytes,
        }));

        // A log file being written by the program that owns it is exactly the file somebody
        // wants to fetch. An exclusive open would refuse precisely the case the feature
        // exists for.
        Assert.Equal("file.chunk", Kind(chunk));
        Assert.Equal(
            "first line\n",
            Encoding.UTF8.GetString(Convert.FromBase64String(chunk!["data"]!.GetValue<string>())));
    }

    /* --------------------------------------------------------------------- */
    /* Writing                                                                */
    /* --------------------------------------------------------------------- */

    private static JsonNode? Send(FileChannel channel, string path, byte[] chunk, long offset, bool final, long total,
        bool overwrite = false, string transferId = TransferId) =>
        channel.Handle("file.write", Message(new
        {
            requestId = RequestId,
            transferId,
            path,
            offset,
            data = Convert.ToBase64String(chunk),
            sha256 = Sha(chunk),
            final,
            overwrite,
            totalBytes = total,
        }));

    [Fact]
    public void An_upload_lands_the_bytes_that_were_sent()
    {
        var contents = new byte[(FileChannel.MaxChunkBytes * 2) + 77];
        new Random(11).NextBytes(contents);

        string destination = Path.Combine(_root, "uploaded.bin");

        FileChannel channel = Channel();
        Grant(channel);

        long offset = 0;
        JsonNode? answer = null;

        while (offset < contents.Length)
        {
            int size = (int)Math.Min(FileChannel.MaxChunkBytes, contents.Length - offset);
            byte[] chunk = contents[(int)offset..((int)offset + size)];
            bool final = offset + size >= contents.Length;

            answer = Send(channel, destination, chunk, offset, final, contents.Length);
            Assert.Equal("file.written", Kind(answer));

            offset += size;
        }

        Assert.True(answer!["complete"]!.GetValue<bool>());
        Assert.Equal(Sha(contents), answer["sha256"]!.GetValue<string>());

        // Byte for byte, and only once the whole thing verified.
        Assert.Equal(contents, System.IO.File.ReadAllBytes(destination));
        Assert.Equal(0, channel.ActiveTransfers);
    }

    [Fact]
    public void An_unfinished_upload_is_a_part_file_and_never_the_real_one()
    {
        string destination = Path.Combine(_root, "installer.exe");

        FileChannel channel = Channel();
        Grant(channel);

        Send(channel, destination, "half of it"u8.ToArray(), 0, final: false, total: 1000);

        // The rename is the moment the file exists. Writing straight to the destination would
        // mean a half-finished transfer looks exactly like a finished one, and somebody
        // double-clicking a 40%-complete installer is worse than a transfer they restart.
        Assert.False(System.IO.File.Exists(destination));
        Assert.True(System.IO.File.Exists(destination + FileChannel.PartSuffix));
        Assert.Equal(1, channel.ActiveTransfers);
    }

    [Fact]
    public void A_resumed_upload_produces_the_same_file_as_an_uninterrupted_one()
    {
        var contents = new byte[FileChannel.MaxChunkBytes + 500];
        new Random(13).NextBytes(contents);

        string destination = Path.Combine(_root, "resumed.bin");

        // First attempt: one chunk, then the connection goes away.
        FileChannel first = Channel();
        Grant(first);
        Send(first, destination, contents[..FileChannel.MaxChunkBytes], 0, final: false, total: contents.Length);
        first.Dispose();

        // Disposal abandons the transfer *and* its part file, which is the honest behaviour:
        // an abandoned transfer leaves nothing behind. So a resume starts over, and the test
        // says so rather than pretending otherwise.
        Assert.False(System.IO.File.Exists(destination + FileChannel.PartSuffix));

        // Second attempt, from the beginning.
        FileChannel second = Channel();
        Grant(second);

        Send(second, destination, contents[..FileChannel.MaxChunkBytes], 0, final: false, total: contents.Length);

        JsonNode? stat = second.Handle("file.stat", Message(new { requestId = RequestId, path = destination }));
        long partial = stat!["partialBytes"]!.GetValue<long>();

        _output.WriteLine($"resuming at {partial} of {contents.Length}");
        Assert.Equal(FileChannel.MaxChunkBytes, partial);

        JsonNode? done = Send(
            second,
            destination,
            contents[FileChannel.MaxChunkBytes..],
            partial,
            final: true,
            total: contents.Length);

        Assert.True(done!["complete"]!.GetValue<bool>());
        Assert.Equal(Sha(contents), done["sha256"]!.GetValue<string>());
        Assert.Equal(contents, System.IO.File.ReadAllBytes(destination));

        second.Dispose();
    }

    [Fact]
    public void A_chunk_that_does_not_match_its_checksum_never_reaches_the_disk()
    {
        string destination = Path.Combine(_root, "corrupt.bin");

        FileChannel channel = Channel();
        Grant(channel);

        JsonNode? refused = channel.Handle("file.write", Message(new
        {
            requestId = RequestId,
            transferId = TransferId,
            path = destination,
            offset = 0,
            data = Convert.ToBase64String("the real bytes"u8.ToArray()),
            sha256 = Sha("something else entirely"u8.ToArray()),
            final = true,
            overwrite = false,
            totalBytes = 14,
        }));

        _output.WriteLine(refused?.ToJsonString());

        // Checked before anything is written. A part file with a corrupt middle is
        // indistinguishable from a good one until the whole transfer fails at the end.
        Assert.Equal("corrupt", Reason(refused));
        Assert.False(System.IO.File.Exists(destination));
        Assert.False(System.IO.File.Exists(destination + FileChannel.PartSuffix));
        Assert.Equal(0, channel.ActiveTransfers);
    }

    [Fact]
    public void A_transfer_that_ends_short_of_what_it_declared_is_thrown_away()
    {
        string destination = Path.Combine(_root, "short.bin");

        FileChannel channel = Channel();
        Grant(channel);

        JsonNode? refused = Send(channel, destination, "only ten!!"u8.ToArray(), 0, final: true, total: 5000);

        _output.WriteLine(refused?.ToJsonString());

        // The declared size is the client's own statement of what it was sending. A file that
        // arrives shorter is a truncated file, and keeping it would hand somebody a document
        // that opens and is missing its last half.
        Assert.Equal("corrupt", Reason(refused));
        Assert.False(System.IO.File.Exists(destination));
        Assert.False(System.IO.File.Exists(destination + FileChannel.PartSuffix));
    }

    [Fact]
    public void A_gap_in_the_offsets_is_answered_with_where_to_continue()
    {
        string destination = Path.Combine(_root, "gapped.bin");

        FileChannel channel = Channel();
        Grant(channel);

        Send(channel, destination, "first"u8.ToArray(), 0, final: false, total: 100);

        JsonNode? answer = Send(channel, destination, "third"u8.ToArray(), 50, final: false, total: 100);

        // A gap would leave a hole full of zeroes that no checksum catches until the whole
        // file is verified. Answered with the real position rather than refused, because a
        // repeat of the last chunk is the ordinary shape of a resume.
        Assert.Equal("file.written", Kind(answer));
        Assert.Equal(5, answer!["bytesWritten"]!.GetValue<long>());
        Assert.False(answer["complete"]!.GetValue<bool>());
    }

    [Fact]
    public void An_existing_file_is_not_replaced_unless_the_transfer_says_so()
    {
        string destination = File("existing.txt", "the original"u8.ToArray());

        FileChannel channel = Channel();
        Grant(channel);

        JsonNode? refused = Send(channel, destination, "the new one"u8.ToArray(), 0, final: true, total: 11);

        // Checked when the transfer starts rather than when it finishes: an operator who
        // finds out they overwrote something after sending 3 GB has been told too late to do
        // anything about it.
        Assert.Equal("exists", Reason(refused));
        Assert.Equal("the original", System.IO.File.ReadAllText(destination));

        JsonNode? done = Send(
            channel, destination, "the new one"u8.ToArray(), 0, final: true, total: 11, overwrite: true);

        Assert.True(done!["complete"]!.GetValue<bool>());
        Assert.Equal("the new one", System.IO.File.ReadAllText(destination));
    }

    [Fact]
    public void WOLF_does_not_write_into_Windows_own_folders()
    {
        FileChannel channel = Channel();
        Grant(channel);

        JsonNode? refused = Send(
            channel,
            @"C:\Windows\System32\drivers\etc\hosts",
            "127.0.0.1 evil.example"u8.ToArray(),
            0,
            final: true,
            total: 22,
            overwrite: true);

        _output.WriteLine(refused?.ToJsonString());

        // Refused outright rather than confirmed. Writing into `C:\Windows` from a remote
        // session is not something an operator does by accident, and a confirmation dialog is
        // the wrong tool for something whose failure mode is an unbootable machine.
        Assert.Equal("rejected", Reason(refused));
    }

    [Fact]
    public void A_stream_may_not_run_more_transfers_than_it_is_allowed()
    {
        FileChannel channel = Channel();
        Grant(channel);

        for (int index = 0; index < FileChannel.MaxTransfers; index++)
        {
            JsonNode? answer = Send(
                channel,
                Path.Combine(_root, $"t{index}.bin"),
                "chunk"u8.ToArray(),
                0,
                final: false,
                total: 1000,
                transferId: $"01J9ZQK7T000000000000000{index}0");

            Assert.Equal("file.written", Kind(answer));
        }

        JsonNode? refused = Send(
            channel, Path.Combine(_root, "one-too-many.bin"), "chunk"u8.ToArray(), 0, false, 1000,
            transferId: "01J9ZQK7T0000000000000000Z");

        // Each transfer holds an open handle and a growing part file. Letting a client start
        // them without bound is a denial of service against the PC's own disk.
        Assert.Equal("too-large", Reason(refused));
        Assert.Equal(FileChannel.MaxTransfers, channel.ActiveTransfers);
    }

    [Fact]
    public void Cancelling_a_transfer_takes_the_part_file_with_it()
    {
        string destination = Path.Combine(_root, "cancelled.bin");

        FileChannel channel = Channel();
        Grant(channel);

        Send(channel, destination, "started"u8.ToArray(), 0, final: false, total: 1000);
        Assert.True(System.IO.File.Exists(destination + FileChannel.PartSuffix));

        channel.Handle("file.cancel", Message(new { requestId = RequestId, transferId = TransferId }));

        Assert.False(System.IO.File.Exists(destination + FileChannel.PartSuffix));
        Assert.Equal(0, channel.ActiveTransfers);
    }

    [Fact]
    public void Losing_the_lease_abandons_every_transfer_in_flight()
    {
        string destination = Path.Combine(_root, "abandoned.bin");

        FileChannel channel = Channel();
        Grant(channel);

        Send(channel, destination, "started"u8.ToArray(), 0, final: false, total: 1000);

        channel.ApplyControl(granted: false, null, null);

        // Half a file on somebody's disk, with nothing to finish it and nothing to explain
        // it, is worse than none.
        Assert.Equal(0, channel.ActiveTransfers);
        Assert.False(System.IO.File.Exists(destination + FileChannel.PartSuffix));
        Assert.False(System.IO.File.Exists(destination));
    }

    /* --------------------------------------------------------------------- */
    /* What gets said about it                                                */
    /* --------------------------------------------------------------------- */

    [Fact]
    public void No_path_or_file_name_reaches_the_log()
    {
        const string Telling = "Divorce settlement final.docx";

        var recorder = new RecordingFileLogs();
        string path = File(Telling, "contents"u8.ToArray());

        FileChannel channel = Channel(loggers: recorder);
        Grant(channel);

        channel.Handle("file.list", Message(new { requestId = RequestId, path = _root }));
        channel.Handle("file.read", Message(new { requestId = RequestId, path, offset = 0, length = 64 }));
        channel.Handle("file.read", Message(new { requestId = RequestId, path = @"C:\..\bad", offset = 0, length = 64 }));

        foreach (string line in recorder.Messages) _output.WriteLine(line);

        // A directory listing is not innocent. `Divorce settlement.docx` is a fact about
        // somebody whether or not the file is ever opened, and a log line naming it would put
        // it exactly where the data-channel routing exists to keep it from — including in the
        // refusal, which is the easiest place to leak one by accident.
        Assert.DoesNotContain(recorder.Messages, m => m.Contains(Telling, StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(recorder.Messages, m => m.Contains(_root, StringComparison.OrdinalIgnoreCase));
        Assert.Contains(recorder.Messages, m => m.Contains("refused", StringComparison.Ordinal));
    }

    [Fact]
    public void A_transfer_is_logged_as_a_size_and_never_as_a_destination()
    {
        var recorder = new RecordingFileLogs();
        string destination = Path.Combine(_root, "Payroll 2026.xlsx");

        FileChannel channel = Channel(loggers: recorder);
        Grant(channel);

        Send(channel, destination, "some bytes"u8.ToArray(), 0, final: true, total: 10);

        foreach (string line in recorder.Messages) _output.WriteLine(line);

        Assert.DoesNotContain(recorder.Messages, m => m.Contains("Payroll", StringComparison.OrdinalIgnoreCase));
        Assert.Contains(recorder.Messages, m => m.Contains("transfer", StringComparison.OrdinalIgnoreCase));
    }

    /* --------------------------------------------------------------------- */

    /// <summary>Keeps every logged line so a test can assert what is <em>not</em> in it.</summary>
    private sealed class RecordingFileLogs : ILoggerFactory
    {
        private readonly ConcurrentQueue<string> _messages = new();

        public IReadOnlyCollection<string> Messages => _messages;

        public ILogger CreateLogger(string categoryName) => new Recorder(_messages, categoryName);

        public void AddProvider(ILoggerProvider provider)
        {
        }

        public void Dispose()
        {
        }

        private sealed class Recorder : ILogger
        {
            private readonly ConcurrentQueue<string> _messages;
            private readonly string _category;

            public Recorder(ConcurrentQueue<string> messages, string category)
            {
                _messages = messages;
                _category = category;
            }

            public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

            public bool IsEnabled(LogLevel logLevel) => true;

            public void Log<TState>(
                LogLevel logLevel,
                EventId eventId,
                TState state,
                Exception? exception,
                Func<TState, Exception?, string> formatter) =>
                _messages.Enqueue($"[{logLevel}] {_category}: {formatter(state, exception)}");
        }
    }
}
