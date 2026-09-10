using System.Runtime.Versioning;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using Wolf.Agent.Core.Ipc;
using Wolf.Agent.SessionHost.Clipboard;
using Wolf.Agent.SessionHost.Input;
using Wolf.Agent.SessionHost.Files;
using Wolf.Agent.SessionHost.Terminal;

namespace Wolf.Agent.SessionHost.Transport;

/// <summary>
/// The data channel, and what arrives on it.
///
/// Input, clipboard and terminal traffic all travel here rather than through the cloud, for
/// different reasons — input because a round trip would add latency to every keystroke, the
/// other two because WOLF must never store what they carry. The consequence is the same for
/// all three: **nothing upstream has validated these bytes**, so everything is checked here.
///
/// The terminal is the one where that matters most. It is arbitrary command execution, and
/// the only thing standing between a stranger and a shell on somebody's PC is the checking
/// <see cref="TerminalChannel"/> does when this hands a message to it.
///
/// Messages are discriminated on `kind` rather than by which fields happen to be present.
/// Guessing would mean a malformed clipboard message could be read as a batch of
/// keystrokes, which is not a mistake worth leaving available.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class ControlChannel
{
    private readonly string _streamId;
    private readonly InputChannel _input;
    private readonly ClipboardChannel _clipboard;
    private readonly TerminalChannel _terminal;
    private readonly FileChannel _files;
    private readonly ILogger<ControlChannel> _logger;

    public ControlChannel(
        string streamId,
        InputChannel input,
        ClipboardChannel clipboard,
        TerminalChannel terminal,
        FileChannel files,
        ILogger<ControlChannel> logger)
    {
        _streamId = streamId;
        _input = input;
        _clipboard = clipboard;
        _terminal = terminal;
        _files = files;
        _logger = logger;
    }

    /// <summary>
    /// Handle one message. Returns what to send back, or null when nothing needs saying.
    ///
    /// A healthy stream is silent in this direction: acknowledging every input batch would
    /// double the message rate for no benefit.
    /// </summary>
    public JsonNode? Handle(byte[] payload)
    {
        JsonElement message;

        try
        {
            using JsonDocument document = JsonDocument.Parse(payload);
            message = document.RootElement.Clone();
        }
        catch (JsonException)
        {
            _logger.LogWarning("Stream {Stream}: a control message could not be read.", _streamId);
            return null;
        }

        if (message.ValueKind != JsonValueKind.Object ||
            !message.TryGetProperty("kind", out JsonElement kindElement) ||
            kindElement.ValueKind != JsonValueKind.String)
        {
            _logger.LogWarning("Stream {Stream}: a control message arrived without a kind.", _streamId);
            return null;
        }

        string? kind = kindElement.GetString();

        return kind switch
        {
            "input" => HandleInput(message),
            "clipboard.content" => HandleClipboard(message),

            // Everything the terminal answers for goes to one place, which checks the
            // capability and the lease before it looks at anything else in the message.
            "terminal.open" or "terminal.input" or "terminal.resize" or "terminal.close" =>
                _terminal.Handle(kind, message),

            // Same again for files: one place that checks the capability, the lease and the
            // path before it looks at anything else in the message.
            "file.list" or "file.stat" or "file.read" or "file.write" or "file.cancel" =>
                _files.Handle(kind, message),

            _ => null,
        };
    }

    private JsonNode? HandleInput(JsonElement message)
    {
        if (!message.TryGetProperty("batch", out JsonElement batch)) return null;

        InputRejection? rejection = _input.Handle(batch);
        if (rejection is null) return null;

        return new JsonObject
        {
            ["kind"] = "input.response",
            ["response"] = JsonSerializer.SerializeToNode(rejection, WolfIpc.Json),
        };
    }

    private JsonNode? HandleClipboard(JsonElement message)
    {
        // Text only, and said so explicitly: a message claiming another format is refused
        // rather than being read as text and pasted as nonsense.
        string? format = ReadString(message, "format");
        if (format != "text")
        {
            return Refusal("unsupported-format", "WOLF carries text on the clipboard, and nothing else.");
        }

        string? text = ReadString(message, "text");
        if (text is null)
        {
            return Refusal("failed", "The clipboard message carried no text.");
        }

        if (text.Length > ClipboardChannel.MaxTextLength)
        {
            return Refusal(
                "too-large",
                $"Clipboard content is limited to {ClipboardChannel.MaxTextLength / 1024} KB of text.");
        }

        ClipboardRefusal? refusal = _clipboard.Apply(text);
        return refusal is null ? null : Refusal(refusal.Reason, refusal.Detail);
    }

    private JsonNode Refusal(string reason, string detail) => new JsonObject
    {
        ["kind"] = "clipboard.refused",
        ["streamId"] = _streamId,
        ["reason"] = reason,
        ["detail"] = detail,
    };

    private static string? ReadString(JsonElement element, string name) =>
        element.TryGetProperty(name, out JsonElement value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
}
