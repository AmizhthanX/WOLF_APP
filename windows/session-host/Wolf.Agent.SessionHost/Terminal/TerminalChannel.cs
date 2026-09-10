using System.Collections.Concurrent;
using System.ComponentModel;
using System.Runtime.Versioning;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;

namespace Wolf.Agent.SessionHost.Terminal;

/// <summary>Sent back to the client when something about a terminal did not happen.</summary>
public sealed record TerminalRefusal(
    [property: JsonPropertyName("terminalId")] string TerminalId,
    [property: JsonPropertyName("reason")] string Reason,
    [property: JsonPropertyName("detail")] string Detail,
    [property: JsonPropertyName("limitation")] bool Limitation)
{
    [JsonPropertyName("kind")]
    public string Kind { get; init; } = "terminal.refused";
}

/// <summary>
/// The gate on running commands.
///
/// This is the one feature in WOLF that is arbitrary command execution, and everything that
/// stands between a stranger and a shell on somebody's PC is in this class. It sits in the
/// same place as <see cref="Input.InputChannel"/> and for the same reason: terminal traffic
/// arrives on the WebRTC data channel, straight from the browser, and **nothing upstream has
/// looked at these bytes**.
///
/// Three checks, in this order, and none of them is a formality:
///
///  1. **Was this session granted a terminal at all?** `terminal` is its own capability,
///     granted per session and separately from screen, input and clipboard. Watching a
///     screen must never imply the right to run commands on it.
///  2. **Does it hold the lease?** The cloud arbitrates `terminal` as an exclusive resource,
///     the way it arbitrates keyboard control, and the lease is enforced here as well —
///     including its expiry, because a cloud that becomes unreachable must not leave a shell
///     open to whoever held it last.
///  3. **Is the message within its bounds?** Sizes, geometry, how many shells one stream may
///     have. The protocol says so and the cloud validates the signaling path, but terminal
///     traffic does not travel that path.
///
/// Elevation is not here at all. `terminal-admin` is a separate capability and is not built:
/// asking for it is answered as an unsupported limitation rather than quietly served with a
/// shell that is not elevated, because a shell that silently is not what it says it is, is
/// worse than no shell.
///
/// **Nothing typed or printed is logged.** What appears in the log is which shell was
/// opened, by which stream, its process id, how many bytes it produced, and how it ended.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class TerminalChannel : IDisposable
{
    /// <summary>Matches the protocol's cap. A larger message is refused rather than truncated.</summary>
    public const int MaxChunkChars = 64 * 1024;

    /// <summary>Matches the protocol's cap on shells per stream.</summary>
    public const int MaxTerminals = 4;

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly string _streamId;
    private readonly bool _allowed;
    private readonly Action<JsonNode> _send;
    private readonly ILoggerFactory _loggers;
    private readonly ILogger<TerminalChannel> _logger;
    private readonly ConcurrentDictionary<string, TerminalSession> _sessions = new(StringComparer.Ordinal);
    private readonly object _gate = new();

    private string? _holderSessionId;
    private DateTimeOffset _leaseExpiresAt = DateTimeOffset.MinValue;
    private bool _disposed;

    public TerminalChannel(
        string streamId,
        bool allowed,
        Action<JsonNode> send,
        ILoggerFactory loggers)
    {
        _streamId = streamId;
        _allowed = allowed;
        _send = send;
        _loggers = loggers;
        _logger = loggers.CreateLogger<TerminalChannel>();
    }

    /// <summary>Whether this session was granted the terminal capability at all.</summary>
    public bool Allowed => _allowed;

    /// <summary>Shells currently open on this stream.</summary>
    public int OpenTerminals => _sessions.Count;

    /// <summary>Whether a shell could be opened right now.</summary>
    public bool HasControl
    {
        get
        {
            if (!_allowed) return false;
            lock (_gate) return _holderSessionId is not null && _leaseExpiresAt > DateTimeOffset.UtcNow;
        }
    }

    /// <summary>
    /// Apply the cloud's decision about who holds the terminal.
    ///
    /// Losing it closes every shell this stream had open. That is deliberate and it is the
    /// difference between a lease and a suggestion: a shell left running after the lease
    /// lapsed is a command prompt on somebody's PC that nothing is watching, and the next
    /// session to take the lease would inherit whatever the last one left half-typed.
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
            _logger.LogInformation(
                "Stream {Stream}: the terminal was granted to session {Session} until {Expiry:o}.",
                _streamId,
                holderSessionId,
                expiresAt);
            return;
        }

        _logger.LogInformation("Stream {Stream}: the terminal lease was released.", _streamId);
        CloseAll("closed");
    }

    /// <summary>
    /// Handle one terminal message from the client.
    ///
    /// Returns what to send back, or null when nothing needs saying — which is the healthy
    /// case for keystrokes: acknowledging every one would double the message rate on the
    /// channel that also carries the screen.
    /// </summary>
    public JsonNode? Handle(string kind, JsonElement message)
    {
        string terminalId = Text(message, "terminalId") ?? string.Empty;

        // Asked before anything is parsed. A session that was never granted a terminal has
        // no business having its geometry validated, and the answer is the same either way.
        if (!HasControl)
        {
            return Refuse(
                terminalId,
                "not-permitted",
                _allowed
                    ? "The terminal lease has expired or is held by another session."
                    : "This session was not granted a terminal on this PC.");
        }

        return kind switch
        {
            "terminal.open" => Open(message, terminalId),
            "terminal.input" => Write(message, terminalId),
            "terminal.resize" => Resize(message, terminalId),
            "terminal.close" => Close(terminalId),
            _ => null,
        };
    }

    private JsonNode? Open(JsonElement message, string terminalId)
    {
        if (string.IsNullOrEmpty(terminalId))
        {
            return Refuse(terminalId, "rejected", "A terminal must be opened with an id.");
        }

        if (_sessions.ContainsKey(terminalId))
        {
            return Refuse(terminalId, "rejected", "A terminal with that id is already open.");
        }

        if (_sessions.Count >= MaxTerminals)
        {
            return Refuse(
                terminalId,
                "too-many",
                $"A stream may hold at most {MaxTerminals} terminals open.");
        }

        // Elevation, asked for and not available. Answered as a limitation rather than
        // served with an unelevated shell that would fail on the first thing it was opened
        // to do — and fail in a way that looks like a permissions bug on the machine.
        if (message.TryGetProperty("elevated", out JsonElement elevated) &&
            elevated.ValueKind == JsonValueKind.True)
        {
            return Refuse(
                terminalId,
                "unsupported",
                "An elevated terminal needs the terminal-admin capability, which this build does not have.",
                limitation: true);
        }

        string? shellName = Text(message, "shell");
        if (shellName is null || !ShellCatalogue.Names.Contains(shellName, StringComparer.Ordinal))
        {
            return Refuse(terminalId, "rejected", "That is not a shell WOLF starts.");
        }

        if (!Geometry(message, out short columns, out short rows, out string? why))
        {
            return Refuse(terminalId, "rejected", why!);
        }

        ResolvedShell? shell = ShellCatalogue.Resolve(shellName);
        if (shell is null)
        {
            return Refuse(
                terminalId,
                "unavailable",
                $"{shellName} is not installed on this PC.",
                limitation: true);
        }

        string? workingDirectory = Text(message, "workingDirectory");

        try
        {
            TerminalSession session = TerminalSession.Start(
                terminalId,
                shell.Name,
                shell.CommandLine,
                workingDirectory,
                columns,
                rows,
                SendOutput,
                SendExit,
                _loggers.CreateLogger<TerminalSession>());

            if (!_sessions.TryAdd(terminalId, session))
            {
                // Two opens with the same id, racing. The loser is closed rather than left
                // running with nothing pointing at it.
                session.Close("closed");
                return Refuse(terminalId, "rejected", "A terminal with that id is already open.");
            }

            // Metadata only, and it is the audit record on the machine itself: which shell,
            // which stream, which pid. An operator looking at the process list should be
            // able to line the two up.
            _logger.LogInformation(
                "Stream {Stream}: opened a {Shell} terminal {Terminal} as pid {Pid}.",
                _streamId,
                shell.Name,
                terminalId,
                session.ProcessId);

            return new JsonObject
            {
                ["kind"] = "terminal.opened",
                ["terminalId"] = terminalId,
                ["shell"] = shell.Name,
                ["processId"] = session.ProcessId,
                ["columns"] = columns,
                ["rows"] = rows,
                ["elevated"] = false,
            };
        }
        catch (Win32Exception ex)
        {
            // The real Windows reason, which is the diagnostic: a shell that is not there
            // and a shell that would not start are different problems.
            _logger.LogWarning(
                "Stream {Stream}: a {Shell} terminal could not be started ({Code}).",
                _streamId,
                shell.Name,
                ex.NativeErrorCode);

            return Refuse(terminalId, "unavailable", $"{shell.Name} could not be started on this PC.", limitation: true);
        }
    }

    private JsonNode? Write(JsonElement message, string terminalId)
    {
        if (!_sessions.TryGetValue(terminalId, out TerminalSession? session))
        {
            return Refuse(terminalId, "unknown-terminal", "That terminal is not open on this stream.");
        }

        if (!message.TryGetProperty("data", out JsonElement data) || data.ValueKind != JsonValueKind.String)
        {
            return Refuse(terminalId, "rejected", "The message carried nothing to type.");
        }

        string text = data.GetString() ?? string.Empty;

        if (text.Length > MaxChunkChars)
        {
            // Refused whole rather than truncated. Half a command is a different command,
            // and this one runs on somebody's PC.
            return Refuse(terminalId, "rejected", $"At most {MaxChunkChars} characters may be sent at once.");
        }

        if (!session.Write(text))
        {
            return Refuse(terminalId, "unknown-terminal", "That terminal has already ended.");
        }

        return null;
    }

    private JsonNode? Resize(JsonElement message, string terminalId)
    {
        if (!_sessions.TryGetValue(terminalId, out TerminalSession? session))
        {
            return Refuse(terminalId, "unknown-terminal", "That terminal is not open on this stream.");
        }

        if (!Geometry(message, out short columns, out short rows, out string? why))
        {
            return Refuse(terminalId, "rejected", why!);
        }

        // A resize that did not land is not worth a message: the shell has exited, and the
        // exit is already on its way to the client.
        session.Resize(columns, rows);
        return null;
    }

    private JsonNode? Close(string terminalId)
    {
        if (!_sessions.TryRemove(terminalId, out TerminalSession? session))
        {
            return Refuse(terminalId, "unknown-terminal", "That terminal is not open on this stream.");
        }

        session.Close("closed");
        return null;
    }

    /// <summary>Close every shell on this stream — the stream ended, or the lease did.</summary>
    public void CloseAll(string reason)
    {
        foreach (string id in _sessions.Keys)
        {
            if (_sessions.TryRemove(id, out TerminalSession? session)) session.Close(reason);
        }
    }

    private void SendOutput(TerminalChunk chunk)
    {
        // Split at the protocol's cap rather than refused: this is the PC talking, and a
        // client that asked for `dir /s` should get all of it.
        for (int offset = 0; offset < chunk.Data.Length; offset += MaxChunkChars)
        {
            int length = Math.Min(MaxChunkChars, chunk.Data.Length - offset);

            _send(new JsonObject
            {
                ["kind"] = "terminal.output",
                ["terminalId"] = chunk.TerminalId,
                ["sequence"] = chunk.Sequence,
                ["data"] = chunk.Data.Substring(offset, length),
            });
        }
    }

    private void SendExit(string terminalId, int? exitCode, string reason)
    {
        _sessions.TryRemove(terminalId, out _);

        _send(new JsonObject
        {
            ["kind"] = "terminal.exited",
            ["terminalId"] = terminalId,
            ["exitCode"] = exitCode,
            ["reason"] = reason,
        });
    }

    private JsonNode Refuse(string terminalId, string reason, string detail, bool limitation = false)
    {
        // The reason code and nothing about the content. A refusal that quoted the message
        // it refused would put a half-typed password in the log.
        _logger.LogWarning(
            "Stream {Stream}: a terminal message was refused ({Reason}).",
            _streamId,
            reason);

        return JsonSerializer.SerializeToNode(
            new TerminalRefusal(terminalId, reason, detail, limitation),
            Json)!;
    }

    private static bool Geometry(JsonElement message, out short columns, out short rows, out string? why)
    {
        columns = 0;
        rows = 0;
        why = null;

        if (!message.TryGetProperty("columns", out JsonElement c) ||
            !message.TryGetProperty("rows", out JsonElement r) ||
            c.ValueKind != JsonValueKind.Number ||
            r.ValueKind != JsonValueKind.Number ||
            !c.TryGetInt32(out int columnCount) ||
            !r.TryGetInt32(out int rowCount))
        {
            why = "The terminal size was missing or unreadable.";
            return false;
        }

        // The same bounds the protocol states. These reach CreatePseudoConsole as a console
        // size, and a shell told it has four billion columns wraps its output unreadably.
        if (columnCount is < 20 or > 500 || rowCount is < 5 or > 200)
        {
            why = "The terminal size is outside the range WOLF supports.";
            return false;
        }

        columns = (short)columnCount;
        rows = (short)rowCount;
        return true;
    }

    private static string? Text(JsonElement message, string property) =>
        message.TryGetProperty(property, out JsonElement value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        CloseAll("stream-ended");
    }
}
