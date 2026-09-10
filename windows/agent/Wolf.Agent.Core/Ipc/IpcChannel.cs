using System.Text;
using System.Text.Json;

namespace Wolf.Agent.Core.Ipc;

/// <summary>
/// Newline-delimited JSON framing over a pipe.
///
/// A length prefix would be marginally more efficient, but newline framing is trivially
/// inspectable when something goes wrong on a customer machine, and the control channel
/// carries a handful of small messages a second rather than a stream of frames. The
/// per-message cap is what stops a malformed or hostile peer from making the reader
/// allocate without bound.
/// </summary>
public sealed class IpcChannel : IDisposable
{
    /// <summary>Largest single message accepted. Control messages are well under a kilobyte. </summary>
    public const int MaxMessageBytes = 256 * 1024;

    /// <summary>
    /// Cap for a channel that carries encoded video as well as control messages.
    ///
    /// The secure-desktop host sends frames up its pipe, and a key frame of a 1440p lock
    /// screen is a few hundred kilobytes before base64 adds a third. Two megabytes is
    /// comfortably above that and still a bound: the point of a cap is that a peer which has
    /// gone wrong cannot make the reader allocate without limit, and that holds at any size.
    /// </summary>
    public const int MaxFrameMessageBytes = 2 * 1024 * 1024;

    private readonly int _maxMessageBytes;

    private readonly Stream _stream;
    private readonly StreamWriter _writer;
    private readonly StreamReader _reader;
    private readonly SemaphoreSlim _writeGate = new(1, 1);

    public IpcChannel(Stream stream, int maxMessageBytes = MaxMessageBytes)
    {
        _maxMessageBytes = maxMessageBytes;
        _stream = stream;
        var encoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);
        _writer = new StreamWriter(stream, encoding) { AutoFlush = false };
        _reader = new StreamReader(stream, encoding, detectEncodingFromByteOrderMarks: false);
    }

    /// <summary>Send one message. Serialized so concurrent senders cannot interleave lines.</summary>
    public async Task SendAsync<T>(T message, CancellationToken cancellationToken)
    {
        string line = JsonSerializer.Serialize(message, WolfIpc.Json);
        if (line.Length > _maxMessageBytes)
        {
            throw new InvalidOperationException("IPC message exceeds the maximum size.");
        }

        await _writeGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await _writer.WriteLineAsync(line.AsMemory(), cancellationToken).ConfigureAwait(false);
            await _writer.FlushAsync(cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            _writeGate.Release();
        }
    }

    /// <summary>
    /// Read messages until the peer disconnects or cancellation is requested.
    ///
    /// A line that is not valid JSON, or is too large, ends the channel rather than being
    /// skipped: on a control channel between two WOLF processes, a malformed message means
    /// something is wrong that silently continuing would hide.
    /// </summary>
    public async IAsyncEnumerable<JsonDocument> ReadAsync(
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            string? line;
            try
            {
                line = await _reader.ReadLineAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is IOException or ObjectDisposedException)
            {
                yield break;
            }

            if (line is null)
            {
                yield break; // Peer closed the pipe.
            }

            if (line.Length == 0)
            {
                continue;
            }

            if (line.Length > _maxMessageBytes)
            {
                throw new InvalidOperationException("IPC message exceeds the maximum size.");
            }

            JsonDocument document;
            try
            {
                document = JsonDocument.Parse(line);
            }
            catch (JsonException ex)
            {
                throw new InvalidOperationException("Malformed IPC message.", ex);
            }

            yield return document;
        }
    }

    /// <summary>Read the message kind, or null when the message does not name one.</summary>
    public static string? KindOf(JsonDocument document) =>
        document.RootElement.TryGetProperty("kind", out JsonElement kind) &&
        kind.ValueKind == JsonValueKind.String
            ? kind.GetString()
            : null;

    /// <summary>True when the peer speaks a version this build understands.</summary>
    public static bool IsSupportedVersion(JsonDocument document) =>
        document.RootElement.TryGetProperty("ipcVersion", out JsonElement version) &&
        version.TryGetInt32(out int value) &&
        value == WolfIpc.Version;

    public void Dispose()
    {
        _writeGate.Dispose();
        _writer.Dispose();
        _reader.Dispose();
        _stream.Dispose();
    }
}
