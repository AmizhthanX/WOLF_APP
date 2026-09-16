using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;

namespace Wolf.Agent.SessionHost.Files;

/// <summary>What the cloud is told about a file operation: which, how it ended, and never a path.</summary>
public sealed record FileActivity(string Operation, string Outcome, string? Reason, long? Bytes);

/// <summary>
/// Changing files: delete, rename, move, new folder.
///
/// On the data channel like browsing, because the alternative — commands queued through the cloud — would put the
/// names of somebody's files into the cloud's command and audit records. What stands in for the command path's
/// accountability:
///
/// - **Every one is reported** through <see cref="FileActivity"/>: the operation and outcome, no path. The relay
///   writes it to the audit trail.
/// - **Delete is the Recycle Bin**, on a drive that has one, and never a permanent delete. If Windows would have to
///   delete something permanently — too large for the bin — it asks the person at the PC, and nothing happens
///   unless they agree.
/// - **Nothing is overwritten.** A rename or move onto a name that is taken is refused.
/// - **Refused outright:** Windows' own folders (as a source or a destination), drive roots, a move to another
///   drive (that is a copy and a delete, and a failure halfway leaves two or none), a folder moved into itself, and
///   anything an upload in flight is writing.
///
/// A link is acted on as the link, not its target, once its target has passed the same gate reads use.
/// </summary>
public sealed partial class FileChannel
{
    /// <summary>How long a delete waits for Windows before saying it is still waiting at the PC.</summary>
    private static readonly TimeSpan DeleteAnswerWithin = TimeSpan.FromSeconds(20);

    private JsonNode? Change(string kind, JsonElement message, string requestId) => kind switch
    {
        "file.delete" => Delete(message, requestId),
        "file.rename" => Rename(message, requestId),
        "file.move" => Move(message, requestId),
        "file.create-folder" => CreateFolder(message, requestId),
        _ => null,
    };

    private JsonNode Delete(JsonElement message, string requestId)
    {
        if (!Existing(message, "path", requestId, "delete", out string path, out JsonNode? refusal)) return refusal!;

        string? root = Path.GetPathRoot(path);
        try
        {
            if (root is null || new DriveInfo(root).DriveType != DriveType.Fixed)
            {
                return Refused("delete", requestId, "unsupported",
                    "Only drives with a Recycle Bin are supported, and this is not one. WOLF does not delete anything permanently.",
                    limitation: true);
            }
        }
        catch (ArgumentException)
        {
            return Refused("delete", requestId, "unsupported", "WOLF could not tell what kind of drive that is.");
        }

        int result = -1;
        bool aborted = false;
        var worker = new Thread(() => result = SendToRecycleBin(path, out aborted)) { IsBackground = true };
        worker.SetApartmentState(ApartmentState.STA);
        worker.Start();

        if (!worker.Join(DeleteAnswerWithin))
        {
            // Windows is asking at the PC whether to delete it permanently. Reported when it finishes, either way.
            _ = Task.Run(() =>
            {
                worker.Join();
                bool gone = !File.Exists(path) && !Directory.Exists(path);
                Report("delete", gone ? "completed" : "refused", gone ? null : "declined-at-pc", null);
            });
            return Refused("delete", requestId, "failed",
                "Windows is asking at the PC whether to delete it permanently, because it will not fit in the Recycle Bin. Nothing more happens unless someone at the PC agrees.",
                limitation: true,
                report: false);
        }

        if (result != 0 || aborted || File.Exists(path) || Directory.Exists(path))
        {
            return Refused("delete", requestId, "failed",
                "Windows did not move that to the Recycle Bin. It may be open in a program, or the account WOLF runs as may not be allowed to change it.",
                limitation: true);
        }

        return Done("delete", requestId);
    }

    private JsonNode Rename(JsonElement message, string requestId)
    {
        string? newName = Text(message, "newName");
        if (!ValidName(newName))
        {
            return Refused("rename", requestId, "rejected", "That is not a name Windows allows.");
        }

        if (!Existing(message, "path", requestId, "rename", out string path, out JsonNode? refusal)) return refusal!;

        string parent = Path.GetDirectoryName(path)!;
        PathVerdict destination = FilePathGuard.Check(Path.Combine(parent, newName!));
        if (!destination.Ok) return Refused("rename", requestId, destination.Reason, destination.Detail, destination.Limitation);

        bool sameExceptCase = string.Equals(path, destination.Normalized, StringComparison.OrdinalIgnoreCase);
        if (!sameExceptCase && (File.Exists(destination.Normalized) || Directory.Exists(destination.Normalized)))
        {
            return Refused("rename", requestId, "exists", "Something in that folder already has that name. Nothing was renamed.");
        }

        return Apply("rename", requestId, () =>
        {
            if (Directory.Exists(path)) Directory.Move(path, destination.Normalized!);
            else File.Move(path, destination.Normalized!, overwrite: false);
        });
    }

    private JsonNode Move(JsonElement message, string requestId)
    {
        if (!Existing(message, "path", requestId, "move", out string path, out JsonNode? refusal)) return refusal!;

        PathVerdict folder = FilePathGuard.Resolve(Text(message, "destinationFolder"));
        if (!folder.Ok) return Refused("move", requestId, folder.Reason, folder.Detail, folder.Limitation);
        if (!Directory.Exists(folder.Normalized))
        {
            return Refused("move", requestId, "rejected", "Things can only be moved into a folder.");
        }
        if (FilePathGuard.IsProtected(folder.Normalized!))
        {
            return Refused("move", requestId, "rejected", "WOLF does not move anything into Windows' own folders.");
        }

        string destination = Path.Combine(folder.Normalized!, Path.GetFileName(path));
        PathVerdict checkedDestination = FilePathGuard.Check(destination);
        if (!checkedDestination.Ok) return Refused("move", requestId, checkedDestination.Reason, checkedDestination.Detail, checkedDestination.Limitation);

        if (!string.Equals(Path.GetPathRoot(path), Path.GetPathRoot(checkedDestination.Normalized), StringComparison.OrdinalIgnoreCase))
        {
            return Refused("move", requestId, "unsupported",
                "WOLF moves things within one drive. Between drives a move is a copy and a delete, and one that fails halfway leaves two copies or none.");
        }

        if (checkedDestination.Normalized!.StartsWith(path + "\\", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(Path.GetDirectoryName(path), folder.Normalized, StringComparison.OrdinalIgnoreCase))
        {
            return Refused("move", requestId, "rejected", "That is already where it would be moved to, or inside itself.");
        }

        if (File.Exists(checkedDestination.Normalized) || Directory.Exists(checkedDestination.Normalized))
        {
            return Refused("move", requestId, "exists", "Something in that folder already has that name. Nothing was moved.");
        }

        return Apply("move", requestId, () =>
        {
            if (Directory.Exists(path)) Directory.Move(path, checkedDestination.Normalized);
            else File.Move(path, checkedDestination.Normalized, overwrite: false);
        });
    }

    private JsonNode CreateFolder(JsonElement message, string requestId)
    {
        PathVerdict verdict = FilePathGuard.Resolve(Text(message, "path"), mustExist: false);
        if (!verdict.Ok) return Refused("create-folder", requestId, verdict.Reason, verdict.Detail, verdict.Limitation);

        string path = verdict.Normalized!;
        if (FilePathGuard.IsProtected(path))
        {
            return Refused("create-folder", requestId, "rejected", "WOLF does not change Windows' own folders.");
        }
        if (File.Exists(path) || Directory.Exists(path))
        {
            return Refused("create-folder", requestId, "exists", "Something already has that name there.");
        }

        return Apply("create-folder", requestId, () => Directory.CreateDirectory(path));
    }

    /* --------------------------------------------------------------------- */

    /// <summary>
    /// A path to something that exists and may be changed. The returned path is the item itself — a link, not
    /// where it points — once where it points has passed the gate.
    /// </summary>
    private bool Existing(JsonElement message, string property, string requestId, string operation, out string path, out JsonNode? refusal)
    {
        path = string.Empty;
        refusal = null;

        string? raw = Text(message, property);
        PathVerdict syntax = FilePathGuard.Check(raw);
        if (!syntax.Ok)
        {
            refusal = Refused(operation, requestId, syntax.Reason, syntax.Detail, syntax.Limitation);
            return false;
        }

        PathVerdict resolved = FilePathGuard.Resolve(raw);
        if (!resolved.Ok)
        {
            refusal = Refused(operation, requestId, resolved.Reason, resolved.Detail, resolved.Limitation);
            return false;
        }

        path = syntax.Normalized!;

        if (Path.GetPathRoot(path) is { } root && string.Equals(root.TrimEnd('\\'), path.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
        {
            refusal = Refused(operation, requestId, "rejected", "A whole drive cannot be changed.");
            return false;
        }

        if (FilePathGuard.IsProtected(path) || FilePathGuard.IsProtected(resolved.Normalized!))
        {
            refusal = Refused(operation, requestId, "rejected", "WOLF does not change Windows' own folders.");
            return false;
        }

        string target = path;
        if (_uploads.Values.Any(upload =>
                string.Equals(upload.DestinationPath, target, StringComparison.OrdinalIgnoreCase) ||
                string.Equals(upload.PartPath, target, StringComparison.OrdinalIgnoreCase) ||
                upload.DestinationPath.StartsWith(target + "\\", StringComparison.OrdinalIgnoreCase)))
        {
            refusal = Refused(operation, requestId, "rejected", "A transfer onto this PC is writing there. Finish or stop it first.");
            return false;
        }

        return true;
    }

    private JsonNode Apply(string operation, string requestId, Action change)
    {
        try
        {
            change();
            return Done(operation, requestId);
        }
        catch (UnauthorizedAccessException)
        {
            return Refused(operation, requestId, "access-denied", "The account WOLF is running as is not allowed to change that on this PC.", limitation: true);
        }
        catch (Exception ex) when (ex is DirectoryNotFoundException or FileNotFoundException)
        {
            return Refused(operation, requestId, "not-found", "It is no longer there.");
        }
        catch (IOException)
        {
            return Refused(operation, requestId, "failed", "Windows would not change it. It may be open in a program.", limitation: true);
        }
    }

    private JsonNode Done(string operation, string requestId)
    {
        _logger.LogInformation("Stream {Stream}: a file {Operation} completed.", _streamId, operation);
        Report(operation, "completed", null, null);
        return new JsonObject { ["kind"] = "file.done", ["requestId"] = requestId, ["operation"] = operation };
    }

    private JsonNode Refused(string operation, string requestId, string reason, string detail, bool limitation = false, bool report = true)
    {
        if (report) Report(operation, "refused", reason, null);
        return Refuse(requestId, reason, detail, limitation);
    }

    private void Report(string operation, string outcome, string? reason, long? bytes)
    {
        try
        {
            _onActivity?.Invoke(new FileActivity(operation, outcome, reason, bytes));
        }
        catch (Exception ex)
        {
            // The audit report failing is not the operation failing. Said in the log, without a path.
            _logger.LogWarning("Stream {Stream}: a file activity report could not be sent ({Error}).", _streamId, ex.GetType().Name);
        }
    }

    private static bool ValidName(string? name)
    {
        if (string.IsNullOrEmpty(name) || name.Length > 255 || name is "." or "..") return false;
        if (name.EndsWith(' ') || name.EndsWith('.')) return false;
        return name.All(c => c >= 32 && "\\/:*?\"<>|".IndexOf(c) < 0);
    }

    /* --------------------------------------------------------------------- */
    /* The Recycle Bin                                                        */
    /* --------------------------------------------------------------------- */

    private const uint FO_DELETE = 0x0003;
    private const ushort FOF_SILENT = 0x0004;
    private const ushort FOF_NOCONFIRMATION = 0x0010;
    private const ushort FOF_ALLOWUNDO = 0x0040;
    private const ushort FOF_NOERRORUI = 0x0400;
    private const ushort FOF_WANTNUKEWARNING = 0x4000;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct SHFILEOPSTRUCT
    {
        public IntPtr hwnd;
        public uint wFunc;
        public string pFrom;
        public string? pTo;
        public ushort fFlags;
        [MarshalAs(UnmanagedType.Bool)] public bool fAnyOperationsAborted;
        public IntPtr hNameMappings;
        public string? lpszProgressTitle;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHFileOperation(ref SHFILEOPSTRUCT operation);

    /// <summary>
    /// Explorer's own delete: to the Recycle Bin, no confirmation and no error dialogs — but a warning at the PC if
    /// Windows would otherwise destroy it permanently, which is the one question that is the local user's to answer.
    /// </summary>
    private static int SendToRecycleBin(string path, out bool aborted)
    {
        var operation = new SHFILEOPSTRUCT
        {
            wFunc = FO_DELETE,
            // The shell reads a list of paths ended by an empty one.
            pFrom = path + "\0\0",
            fFlags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT | FOF_WANTNUKEWARNING,
        };
        int result = SHFileOperation(ref operation);
        aborted = operation.fAnyOperationsAborted;
        return result;
    }
}
