using System.Collections.Concurrent;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;

namespace Wolf.Agent.SessionHost.Files;

/// <summary>
/// Browsing this PC's disks, and moving files across the data channel.
///
/// The same shape as <see cref="Terminal.TerminalChannel"/> and <see cref="Input.InputChannel"/>,
/// and for the same reason: file traffic arrives straight from the browser on the WebRTC data
/// channel, so **nothing upstream has looked at any of it**. Every check is here.
///
/// Three of them, in this order:
///
///  1. **Was this session granted file transfer at all?** `file-transfer` is its own
///     capability. Seeing a screen is not being handed the disks behind it.
///  2. **Does it hold the lease, and has it expired?** `file-operations` is arbitrated by the
///     cloud, and enforced here as well — a cloud that becomes unreachable must not leave a
///     transfer running for whoever held it last.
///  3. **Is the path one WOLF will touch?** <see cref="FilePathGuard"/>, both halves: the
///     string, and then what it actually is on the disk.
///
/// **What the account may read is Windows' decision, not this class's.** The session host runs
/// as the signed-in user, so a folder they cannot open is a folder WOLF cannot open, with no
/// extra code and nothing to get wrong. An operator does not gain access by coming in
/// remotely.
///
/// **Nothing here logs a path.** A directory listing is not innocent — `Divorce
/// settlement.docx` is a fact about somebody whether or not the file is opened — and a log
/// line naming it would put it exactly where the whole data-channel routing exists to keep it
/// from. What is logged is the operation, the outcome, and how many bytes.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed partial class FileChannel : IDisposable
{
    /// <summary>Matches the protocol. A larger chunk is refused rather than truncated.</summary>
    public const int MaxChunkBytes = 64 * 1024;

    /// <summary>Matches the protocol's cap on directory entries returned at once.</summary>
    public const int MaxEntries = 2000;

    /// <summary>Matches the protocol's cap on transfers in flight per stream.</summary>
    public const int MaxTransfers = 4;

    /// <summary>Matches the protocol's cap on the size of a single transfer.</summary>
    public const long MaxTransferBytes = 8L * 1024 * 1024 * 1024;

    /// <summary>The suffix an unfinished upload wears until it is verified.</summary>
    public const string PartSuffix = ".wolfpart";

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly string _streamId;
    private readonly bool _allowed;
    private readonly ILogger<FileChannel> _logger;
    private readonly ConcurrentDictionary<string, Upload> _uploads = new(StringComparer.Ordinal);
    private readonly object _gate = new();

    private readonly PartialUploads _partials;
    private readonly Func<DateTimeOffset> _clock;
    private readonly Action<FileActivity>? _onActivity;

    private string? _holderSessionId;
    private DateTimeOffset _leaseExpiresAt = DateTimeOffset.MinValue;
    private bool _disposed;

    /// <summary>
    /// Every message here is answered, and nothing is pushed.
    ///
    /// Unlike the terminal, which produces output nobody asked for, a file channel only ever
    /// speaks when spoken to — so there is no sender to hold, and a client that stops asking
    /// stops hearing.
    /// </summary>
    public FileChannel(
        string streamId,
        bool allowed,
        ILoggerFactory loggers,
        PartialUploads? partialUploads = null,
        Func<DateTimeOffset>? clock = null,
        Action<FileActivity>? onActivity = null)
    {
        _streamId = streamId;
        _allowed = allowed;
        _logger = loggers.CreateLogger<FileChannel>();
        _partials = partialUploads ?? PartialUploads.ForCurrentUser(loggers);
        _clock = clock ?? (() => DateTimeOffset.UtcNow);
        _onActivity = onActivity;

        // A stream starting is when a part file left by an earlier one is either resumed or past waiting for.
        _partials.Sweep(_clock());
    }

    /// <summary>An upload in progress, and the part file it is accumulating into.</summary>
    private sealed class Upload : IDisposable
    {
        public required string PartPath { get; init; }
        public required string DestinationPath { get; init; }
        public required FileStream Stream { get; init; }
        public required IncrementalHash Digest { get; init; }
        public required long TotalBytes { get; init; }
        public required bool Overwrite { get; init; }
        public long Written { get; set; }

        public void Dispose()
        {
            Stream.Dispose();
            Digest.Dispose();
        }
    }

    public bool Allowed => _allowed;

    public int ActiveTransfers => _uploads.Count;

    /// <summary>Whether files could be browsed or moved right now.</summary>
    public bool HasControl
    {
        get
        {
            if (!_allowed) return false;
            lock (_gate) return _holderSessionId is not null && _leaseExpiresAt > DateTimeOffset.UtcNow;
        }
    }

    /// <summary>
    /// Apply the cloud's decision about who may touch this PC's files.
    ///
    /// Losing the lease puts every transfer in flight aside. Their part files are kept for
    /// <see cref="PartialUploads.KeptFor"/> so a new stream can finish them, and removed if none
    /// does: an interruption is not a decision to stop, and half a file left indefinitely, with
    /// nothing to finish it, is worse than none.
    /// </summary>
    public void ApplyControl(bool granted, string? holderSessionId, DateTimeOffset? expiresAt)
    {
        lock (_gate)
        {
            if (granted && expiresAt is not null)
            {
                _holderSessionId = holderSessionId;
                _leaseExpiresAt = expiresAt.Value;
            }
            else
            {
                _holderSessionId = null;
                _leaseExpiresAt = DateTimeOffset.MinValue;
            }
        }

        if (granted)
        {
            _partials.Sweep(_clock());
            _logger.LogInformation(
                "Stream {Stream}: file access granted to session {Session} until {Expiry:o}.",
                _streamId,
                holderSessionId,
                expiresAt);
            return;
        }

        _logger.LogInformation("Stream {Stream}: the file lease was released.", _streamId);
        SuspendAll();
    }

    /// <summary>Handle one file message. Returns what to send back, or null when nothing does.</summary>
    public JsonNode? Handle(string kind, JsonElement message)
    {
        string requestId = Text(message, "requestId") ?? string.Empty;

        // Asked before anything is parsed. A session without the capability has no business
        // having its paths validated, and the answer is the same either way.
        if (!HasControl)
        {
            return Refuse(
                requestId,
                "not-permitted",
                _allowed
                    ? "The file lease has expired or is held by another session."
                    : "This session was not granted access to this PC's files.");
        }

        return kind switch
        {
            "file.list" => List(message, requestId),
            "file.stat" => Stat(message, requestId),
            "file.read" => Read(message, requestId),
            "file.write" => Write(message, requestId),
            "file.cancel" => Cancel(message, requestId),
            _ => Change(kind, message, requestId),
        };
    }

    /* --------------------------------------------------------------------- */
    /* Browsing                                                               */
    /* --------------------------------------------------------------------- */

    private JsonNode? List(JsonElement message, string requestId)
    {
        string? path = Text(message, "path");

        if (path is null) return Drives(requestId);

        PathVerdict verdict = FilePathGuard.Resolve(path);
        if (!verdict.Ok) return Refuse(requestId, verdict.Reason, verdict.Detail, verdict.Limitation);

        string directory = verdict.Normalized!;

        if (!Directory.Exists(directory))
        {
            return Refuse(requestId, "rejected", "That path is a file, not a folder.");
        }

        var entries = new JsonArray();
        bool truncated = false;

        try
        {
            foreach (FileSystemInfo item in new DirectoryInfo(directory)
                         .EnumerateFileSystemInfos("*", SearchOption.TopDirectoryOnly))
            {
                if (entries.Count >= MaxEntries)
                {
                    // Said rather than silently cut. A folder that shows 2000 of its 40000
                    // files with no indication is one an operator concludes does not contain
                    // what they are looking for.
                    truncated = true;
                    break;
                }

                entries.Add(Describe(item));
            }
        }
        catch (UnauthorizedAccessException)
        {
            return Refuse(
                requestId,
                "access-denied",
                "The account WOLF is running as cannot read that folder on this PC.",
                limitation: true);
        }
        catch (Exception ex) when (ex is IOException or ArgumentException)
        {
            return Refuse(requestId, "failed", "That folder could not be read on this PC.");
        }

        _logger.LogDebug(
            "Stream {Stream}: listed {Count} entr(ies){Truncated}.",
            _streamId,
            entries.Count,
            truncated ? ", truncated" : string.Empty);

        return new JsonObject
        {
            ["kind"] = "file.listing",
            ["requestId"] = requestId,
            ["path"] = directory,
            ["entries"] = entries,
            ["truncated"] = truncated,
        };
    }

    /// <summary>
    /// The drives, as the root of the tree.
    ///
    /// Only ready, fixed and removable ones: a mapped network drive is a path to another
    /// machine, and WOLF browses this PC's own disks — see <see cref="FilePathGuard"/> for why
    /// that is a decision rather than an omission. An unready drive is an empty optical bay,
    /// and offering it produces an error nobody can act on.
    /// </summary>
    private static JsonNode Drives(string requestId)
    {
        var entries = new JsonArray();

        foreach (DriveInfo drive in DriveInfo.GetDrives())
        {
            if (drive.DriveType is not (DriveType.Fixed or DriveType.Removable)) continue;

            long? free = null;
            string label = drive.Name;

            try
            {
                if (!drive.IsReady) continue;
                free = drive.AvailableFreeSpace;
                if (!string.IsNullOrWhiteSpace(drive.VolumeLabel)) label = $"{drive.VolumeLabel} ({drive.Name})";
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                continue;
            }

            entries.Add(new JsonObject
            {
                ["name"] = label,
                ["kind"] = "drive",
                ["sizeBytes"] = free,
                ["modifiedAt"] = null,
                ["readOnly"] = false,
                ["hidden"] = false,
                ["reparse"] = false,
                ["protectedLocation"] = false,
                ["path"] = drive.Name.TrimEnd('\\'),
            });
        }

        return new JsonObject
        {
            ["kind"] = "file.listing",
            ["requestId"] = requestId,
            ["path"] = null,
            ["entries"] = entries,
            ["truncated"] = false,
        };
    }

    private static JsonNode Describe(FileSystemInfo item)
    {
        bool directory = item.Attributes.HasFlag(FileAttributes.Directory);
        long? size = null;

        if (!directory && item is FileInfo file)
        {
            try
            {
                size = file.Length;
            }
            catch (IOException)
            {
                // A file that vanished between the enumeration and this read. Listed with an
                // unknown size rather than failing the whole directory for one entry.
            }
        }

        return new JsonObject
        {
            ["name"] = item.Name,
            ["kind"] = directory ? "directory" : "file",
            ["sizeBytes"] = size,
            ["modifiedAt"] = item.LastWriteTimeUtc.ToString("o"),
            ["readOnly"] = item.Attributes.HasFlag(FileAttributes.ReadOnly),
            ["hidden"] = item.Attributes.HasFlag(FileAttributes.Hidden),
            // Surfaced rather than hidden: an operator about to copy a folder should know
            // when it is really a link to somewhere else on the machine.
            ["reparse"] = item.Attributes.HasFlag(FileAttributes.ReparsePoint),
            ["protectedLocation"] = FilePathGuard.IsProtected(item.FullName),
        };
    }

    private JsonNode? Stat(JsonElement message, string requestId)
    {
        string? path = Text(message, "path");

        // Not required to exist: this is what a resumed upload asks, and the answer it needs
        // is often "nothing is there yet, and here is how far the part file got".
        PathVerdict verdict = FilePathGuard.Resolve(path, mustExist: false);
        if (!verdict.Ok && verdict.Reason != "not-found")
        {
            return Refuse(requestId, verdict.Reason, verdict.Detail, verdict.Limitation);
        }

        string resolved = verdict.Normalized ?? FilePathGuard.Check(path).Normalized ?? string.Empty;

        JsonNode? entry = null;
        if (File.Exists(resolved)) entry = Describe(new FileInfo(resolved));
        else if (Directory.Exists(resolved)) entry = Describe(new DirectoryInfo(resolved));

        long? partial = null;
        string partPath = resolved + PartSuffix;
        if (File.Exists(partPath))
        {
            try
            {
                partial = new FileInfo(partPath).Length;
            }
            catch (IOException)
            {
                partial = null;
            }
        }

        return new JsonObject
        {
            ["kind"] = "file.info",
            ["requestId"] = requestId,
            ["path"] = resolved,
            ["entry"] = entry,
            ["partialBytes"] = partial,
        };
    }

    /* --------------------------------------------------------------------- */
    /* Reading                                                                */
    /* --------------------------------------------------------------------- */

    private JsonNode? Read(JsonElement message, string requestId)
    {
        PathVerdict verdict = FilePathGuard.Resolve(Text(message, "path"));
        if (!verdict.Ok) return Refuse(requestId, verdict.Reason, verdict.Detail, verdict.Limitation);

        string path = verdict.Normalized!;

        if (!File.Exists(path))
        {
            return Refuse(requestId, "rejected", "That path is a folder, not a file.");
        }

        if (!Number(message, "offset", out long offset) || offset < 0)
        {
            return Refuse(requestId, "rejected", "A read needs an offset.");
        }

        if (!Number(message, "length", out long length) || length < 1 || length > MaxChunkBytes)
        {
            return Refuse(requestId, "rejected", $"A read may ask for at most {MaxChunkBytes} bytes.");
        }

        try
        {
            using var stream = new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                // Shared on purpose: a log file being written by the program that owns it is
                // exactly the file somebody wants to fetch, and an exclusive open would refuse
                // precisely the case the feature exists for.
                FileShare.ReadWrite | FileShare.Delete);

            long total = stream.Length;

            if (total > MaxTransferBytes)
            {
                return Refuse(
                    requestId,
                    "too-large",
                    $"WOLF moves files up to {MaxTransferBytes / (1024 * 1024 * 1024)} GB.");
            }

            if (offset > total)
            {
                return Refuse(requestId, "rejected", "That offset is past the end of the file.");
            }

            stream.Seek(offset, SeekOrigin.Begin);

            var buffer = new byte[Math.Min(length, total - offset)];
            int read = stream.ReadAtLeast(buffer, buffer.Length, throwOnEndOfStream: false);

            byte[] chunk = read == buffer.Length ? buffer : buffer[..read];

            // The last chunk of a download, for the audit trail: that a file of this size left the PC.
            if (offset + read >= total && read > 0) Report("download", "completed", null, total);

            return new JsonObject
            {
                ["kind"] = "file.chunk",
                ["requestId"] = requestId,
                ["offset"] = offset,
                ["data"] = Convert.ToBase64String(chunk),
                // Per chunk, so a byte that arrives wrong is caught where it happened rather
                // than as a file that turns out to be broken a week later.
                ["sha256"] = Hex(SHA256.HashData(chunk)),
                ["eof"] = offset + read >= total,
                ["totalBytes"] = total,
            };
        }
        catch (UnauthorizedAccessException)
        {
            return Refuse(
                requestId,
                "access-denied",
                "The account WOLF is running as cannot read that file on this PC.",
                limitation: true);
        }
        catch (IOException)
        {
            return Refuse(requestId, "failed", "That file could not be read on this PC.");
        }
    }

    /* --------------------------------------------------------------------- */
    /* Writing                                                                */
    /* --------------------------------------------------------------------- */

    private JsonNode? Write(JsonElement message, string requestId)
    {
        string transferId = Text(message, "transferId") ?? string.Empty;
        if (transferId.Length == 0) return Refuse(requestId, "rejected", "A write needs a transfer id.");

        if (!Number(message, "offset", out long offset) || offset < 0)
        {
            return Refuse(requestId, "rejected", "A write needs an offset.");
        }

        string? encoded = Text(message, "data");
        string? expected = Text(message, "sha256");

        if (encoded is null || expected is null)
        {
            return Refuse(requestId, "rejected", "A write needs data and its checksum.");
        }

        byte[] chunk;
        try
        {
            chunk = Convert.FromBase64String(encoded);
        }
        catch (FormatException)
        {
            return Refuse(requestId, "rejected", "That chunk was not valid base64.");
        }

        if (chunk.Length > MaxChunkBytes)
        {
            return Refuse(requestId, "rejected", $"A chunk may be at most {MaxChunkBytes} bytes.");
        }

        // Checked before anything is written. A chunk that arrived wrong must not reach the
        // disk at all: a part file with a corrupt middle is indistinguishable from a good one
        // until the whole transfer fails at the end.
        if (!string.Equals(Hex(SHA256.HashData(chunk)), expected, StringComparison.OrdinalIgnoreCase))
        {
            return Refuse(requestId, "corrupt", "That chunk did not match its checksum and was not written.");
        }

        bool final = Flag(message, "final");

        if (!_uploads.TryGetValue(transferId, out Upload? upload))
        {
            JsonNode? refusal = Begin(message, requestId, transferId, offset, out upload);
            if (refusal is not null) return refusal;
        }

        // Offsets have to be contiguous. A gap would leave a hole full of zeroes that no
        // checksum catches until the whole file is verified, and by then the source may be
        // gone. A repeat of the last chunk is the ordinary shape of a resume, so it is
        // answered with where to continue rather than refused.
        if (offset != upload!.Written)
        {
            return new JsonObject
            {
                ["kind"] = "file.written",
                ["requestId"] = requestId,
                ["transferId"] = transferId,
                ["bytesWritten"] = upload.Written,
                ["sha256"] = null,
                ["complete"] = false,
            };
        }

        try
        {
            upload.Stream.Write(chunk, 0, chunk.Length);
            upload.Stream.Flush();
            upload.Digest.AppendData(chunk);
            upload.Written += chunk.Length;
        }
        catch (IOException)
        {
            Abandon(transferId);
            return Refuse(requestId, "failed", "That file could not be written on this PC.");
        }

        if (!final)
        {
            return new JsonObject
            {
                ["kind"] = "file.written",
                ["requestId"] = requestId,
                ["transferId"] = transferId,
                ["bytesWritten"] = upload.Written,
                ["sha256"] = null,
                ["complete"] = false,
            };
        }

        return Finish(requestId, transferId, upload, Text(message, "fileSha256"));
    }

    /// <summary>
    /// Open a transfer, or say why it cannot start.
    ///
    /// Everything expensive to get wrong is decided here rather than at the end: whether
    /// something is already there, whether there is room, whether the destination is somewhere
    /// WOLF writes at all. An operator who finds out they overwrote a file after sending 3 GB
    /// has been told too late to do anything about it.
    /// </summary>
    private JsonNode? Begin(
        JsonElement message,
        string requestId,
        string transferId,
        long offset,
        out Upload? upload)
    {
        upload = null;

        if (_uploads.Count >= MaxTransfers)
        {
            return Refuse(requestId, "too-large", $"A stream may run at most {MaxTransfers} transfers at once.");
        }

        PathVerdict verdict = FilePathGuard.Resolve(Text(message, "path"), mustExist: false);
        if (!verdict.Ok) return Refuse(requestId, verdict.Reason, verdict.Detail, verdict.Limitation);

        string destination = verdict.Normalized!;

        if (FilePathGuard.IsProtected(destination))
        {
            // Refused outright rather than confirmed. Writing into `C:\Windows` from a remote
            // session is not a thing an operator does by accident, and a confirmation dialog
            // is the wrong tool for something whose failure mode is an unbootable machine.
            return Refuse(
                requestId,
                "rejected",
                "WOLF does not write into Windows' own folders.");
        }

        bool overwrite = Flag(message, "overwrite");

        if (File.Exists(destination) && !overwrite)
        {
            return Refuse(requestId, "exists", "A file is already there. Nothing was written.");
        }

        if (!Number(message, "totalBytes", out long total) || total < 0 || total > MaxTransferBytes)
        {
            return Refuse(requestId, "too-large", "That transfer is larger than WOLF moves.");
        }

        string partPath = destination + PartSuffix;

        try
        {
            string? directory = Path.GetDirectoryName(destination);
            if (directory is not null)
            {
                var drive = new DriveInfo(Path.GetPathRoot(directory) ?? "C:\\");
                if (drive.IsReady && drive.AvailableFreeSpace < total)
                {
                    // Before a byte is sent, rather than when the disk fills. A failed
                    // transfer that also filled somebody's system drive is two problems.
                    return Refuse(
                        requestId,
                        "too-large",
                        "There is not enough free space on that drive for this file.");
                }
            }

            // Resuming reuses the part file; starting fresh truncates it. Which of the two is
            // decided by the offset the client asked to write at, because the client is the
            // one that asked for the part file's length before it began.
            // Read as well as write: a resumed transfer hashes the part it already has through this
            // same handle, because a second handle could not open a file this one holds exclusively.
            var stream = new FileStream(
                partPath,
                offset > 0 ? FileMode.OpenOrCreate : FileMode.Create,
                FileAccess.ReadWrite,
                FileShare.None);

            if (offset > 0 && offset <= stream.Length)
            {
                stream.SetLength(offset);
            }
            else if (offset > 0)
            {
                stream.Dispose();
                return Refuse(requestId, "rejected", "That resume point is past the end of the partial file.");
            }

            var digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);

            // A resumed transfer hashes the part already on disk first, so the digest reported at
            // the end covers the whole file as it now sits on this PC, not just what this stream
            // sent — which is what lets a client's own whole-file checksum be compared against it.
            if (offset > 0)
            {
                try
                {
                    stream.Seek(0, SeekOrigin.Begin);
                    var buffer = new byte[MaxChunkBytes];
                    long remaining = offset;

                    while (remaining > 0)
                    {
                        int read = stream.Read(buffer, 0, (int)Math.Min(buffer.Length, remaining));
                        if (read <= 0) throw new IOException("The partial file is shorter than it was.");
                        digest.AppendData(buffer.AsSpan(0, read));
                        remaining -= read;
                    }

                    stream.Seek(offset, SeekOrigin.Begin);
                }
                catch (IOException)
                {
                    stream.Dispose();
                    digest.Dispose();
                    return Refuse(requestId, "failed", "The partial file could not be read back to resume.");
                }
            }

            upload = new Upload
            {
                PartPath = partPath,
                DestinationPath = destination,
                Stream = stream,
                Digest = digest,
                TotalBytes = total,
                Overwrite = overwrite,
                Written = offset,
            };

            if (!_uploads.TryAdd(transferId, upload))
            {
                upload.Dispose();
                upload = null;
                return Refuse(requestId, "rejected", "A transfer with that id is already running.");
            }

            // Started or resumed: the part file is this transfer's again, not waiting to be cleared.
            _partials.Claim(partPath);

            _logger.LogInformation(
                "Stream {Stream}: began a {Bytes}-byte transfer onto this PC{Resume}.",
                _streamId,
                total,
                offset > 0 ? $", resuming at {offset}" : string.Empty);

            return null;
        }
        catch (UnauthorizedAccessException)
        {
            return Refuse(
                requestId,
                "access-denied",
                "The account WOLF is running as cannot write there on this PC.",
                limitation: true);
        }
        catch (IOException)
        {
            return Refuse(requestId, "failed", "That file could not be created on this PC.");
        }
    }

    /// <summary>
    /// Verify the part file and put it where it belongs.
    ///
    /// The rename is the moment the file exists. Writing straight to the destination would
    /// mean a half-finished transfer looks exactly like a finished one, and somebody
    /// double-clicking a 40%-complete installer is a worse outcome than a transfer they have
    /// to start again.
    ///
    /// When the client sends its own whole-file checksum, a file that does not match is not put
    /// in place at all. That matters most for a resumed upload, whose first part was written by an
    /// earlier stream: a mismatch found after the rename is found with the wrong file already where
    /// the owner expects the right one.
    /// </summary>
    private JsonNode Finish(string requestId, string transferId, Upload upload, string? expectedWholeFile)
    {
        string digest = Hex(upload.Digest.GetHashAndReset());

        try
        {
            upload.Stream.Dispose();

            if (upload.TotalBytes > 0 && upload.Written != upload.TotalBytes)
            {
                Abandon(transferId);
                return Refuse(
                    requestId,
                    "corrupt",
                    $"The transfer ended at {upload.Written} bytes but was declared as {upload.TotalBytes}. Nothing was kept.");
            }

            if (expectedWholeFile is not null && !string.Equals(expectedWholeFile, digest, StringComparison.OrdinalIgnoreCase))
            {
                Abandon(transferId);
                return Refuse(
                    requestId,
                    "corrupt",
                    "The file put together on this PC does not match the one sent, so it was not put in place. Send it again from the start.");
            }

            File.Move(upload.PartPath, upload.DestinationPath, overwrite: upload.Overwrite);

            _uploads.TryRemove(transferId, out _);
            upload.Digest.Dispose();

            _logger.LogInformation(
                "Stream {Stream}: completed a {Bytes}-byte transfer onto this PC.",
                _streamId,
                upload.Written);
            Report("upload", "completed", null, upload.Written);

            return new JsonObject
            {
                ["kind"] = "file.written",
                ["requestId"] = requestId,
                ["transferId"] = transferId,
                ["bytesWritten"] = upload.Written,
                ["sha256"] = digest,
                ["complete"] = true,
            };
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Abandon(transferId);
            return Refuse(requestId, "failed", "The finished file could not be put in place on this PC.");
        }
    }

    private JsonNode? Cancel(JsonElement message, string requestId)
    {
        string transferId = Text(message, "transferId") ?? string.Empty;
        Abandon(transferId);

        return new JsonObject
        {
            ["kind"] = "file.written",
            ["requestId"] = requestId,
            ["transferId"] = transferId,
            ["bytesWritten"] = 0,
            ["sha256"] = null,
            ["complete"] = false,
        };
    }

    /// <summary>Drop a transfer and the part file with it.</summary>
    private void Abandon(string transferId)
    {
        if (!_uploads.TryRemove(transferId, out Upload? upload)) return;

        string partPath = upload.PartPath;
        upload.Dispose();

        try
        {
            if (File.Exists(partPath)) File.Delete(partPath);
            _partials.Claim(partPath);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Nothing useful to do, and nothing to report to the client: the transfer is over
            // either way, and the leftover is a `.wolfpart` file that names itself.
            _logger.LogWarning("Stream {Stream}: a partial file could not be removed.", _streamId);
        }
    }

    /// <summary>
    /// Put every transfer in flight aside — the lease lapsed, or the stream ended.
    ///
    /// Interrupted, not stopped: the handles close, and the part files stay for
    /// <see cref="PartialUploads.KeptFor"/> so a new stream can finish them. Stopping a transfer is
    /// <c>file.cancel</c>, which removes its part file at once.
    /// </summary>
    public void SuspendAll()
    {
        foreach (string id in _uploads.Keys)
        {
            if (!_uploads.TryRemove(id, out Upload? upload)) continue;
            upload.Dispose();
            _partials.Keep(upload.PartPath, _clock());
        }
    }

    /* --------------------------------------------------------------------- */

    private JsonNode Refuse(string requestId, string reason, string detail, bool limitation = false)
    {
        // The code and nothing else. A refusal that named the path it refused would put
        // `Divorce settlement.docx` in a log, which is exactly what the data channel exists
        // to avoid.
        _logger.LogWarning("Stream {Stream}: a file request was refused ({Reason}).", _streamId, reason);

        return JsonSerializer.SerializeToNode(
            new
            {
                kind = "file.refused",
                requestId,
                reason,
                detail,
                limitation,
            },
            Json)!;
    }

    private static string Hex(byte[] bytes) => Convert.ToHexStringLower(bytes);

    private static string? Text(JsonElement message, string property) =>
        message.TryGetProperty(property, out JsonElement value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static bool Number(JsonElement message, string property, out long value)
    {
        value = 0;
        return message.TryGetProperty(property, out JsonElement element) &&
               element.ValueKind == JsonValueKind.Number &&
               element.TryGetInt64(out value);
    }

    private static bool Flag(JsonElement message, string property) =>
        message.TryGetProperty(property, out JsonElement value) && value.ValueKind == JsonValueKind.True;

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        SuspendAll();
    }
}
