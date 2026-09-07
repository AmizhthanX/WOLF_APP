using System.Runtime.Versioning;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using Wolf.Agent.Core.Ipc;
using Wolf.Agent.SessionHost.Clipboard;
using Wolf.Agent.SessionHost.Input;

namespace Wolf.Agent.SessionHost.Transport;

/// <summary>
/// The data channel, and what arrives on it.
///
/// Input and clipboard both travel here rather than through the cloud, for different
/// reasons — input because a round trip would add latency to every keystroke, clipboard
/// because WOLF must never store what somebody copied. The consequence is the same for
/// both: **nothing upstream has validated these bytes**, so everything is checked here.
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
    private readonly ILogger<ControlChannel> _logger;

    public ControlChannel(
        string streamId,
        InputChannel input,
        ClipboardChannel clipboard,
        ILogger<ControlChannel> logger)
    {
        _streamId = streamId;
        _input = input;
        _clipboard = clipboard;
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

        return kindElement.GetString() switch
        {
            "input" => HandleInput(message),
            "clipboard.content" => HandleClipboard(message),
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
