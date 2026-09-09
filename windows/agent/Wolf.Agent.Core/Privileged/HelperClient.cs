using System.IO.Pipes;
using System.Runtime.Versioning;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Wolf.Agent.Core.Ipc;

namespace Wolf.Agent.Core.Privileged;

/// <summary>What came back from the helper, or why nothing did.</summary>
public sealed record HelperOutcome(bool Ok, JsonElement? Result, string? Code, string? Message)
{
    public static HelperOutcome Unavailable(string message) =>
        new(false, null, "helper-unavailable", message);
}

/// <summary>
/// The agent's side of the privileged helper channel.
///
/// Connects for one exchange and disconnects: the helper allows a single connection at a
/// time, and holding one open would mean a rarely used privileged channel sitting open for
/// the life of the agent for no reason. Privileged operations happen at human pace, so the
/// few milliseconds of connecting are not worth keeping a door open for.
///
/// The helper not being installed is an ordinary answer here, not a fault. Milestone 3 ships
/// the helper; a PC that has not been updated yet simply reports that the operations needing
/// it are unavailable, which the cloud already knows how to say.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class HelperClient
{
    /// <summary>
    /// How long to wait for the helper to accept a connection.
    ///
    /// Short. The helper is either running on this machine or it is not, and a caller
    /// waiting on a privileged read has an operator waiting behind it.
    /// </summary>
    private static readonly TimeSpan ConnectTimeout = TimeSpan.FromSeconds(3);

    /// <summary>How long to wait for an answer once connected.</summary>
    private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(30);

    private readonly ILogger<HelperClient> _logger;
    private long _sequence;

    public HelperClient(ILogger<HelperClient> logger)
    {
        _logger = logger;
    }

    /// <summary>
    /// Whether the helper is listening, without exchanging anything with it.
    ///
    /// What the capability handshake needs: "is the privileged helper installed and running
    /// on this PC". Answered by opening the pipe and closing it again, which is a
    /// millisecond when it is there and bounded when it is not.
    ///
    /// Deliberately not the same question as "will it serve this caller" — a helper that is
    /// running but refuses this agent is reported as available here and refuses the command
    /// with a reason, which is the more useful pair of answers than one flag conflating them.
    /// </summary>
    public static bool IsListening()
    {
        try
        {
            using var pipe = new NamedPipeClientStream(".", HelperProtocol.PipeName, PipeDirection.InOut);
            pipe.Connect((int)ProbeTimeout.TotalMilliseconds);
            return true;
        }
        catch (Exception ex) when (ex is TimeoutException or IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    /// <summary>How long to wait when only asking whether the helper is there at all.</summary>
    private static readonly TimeSpan ProbeTimeout = TimeSpan.FromMilliseconds(400);

    /// <summary>Whether the helper answered a describe. Used where a real exchange is wanted.</summary>
    public async Task<bool> IsAvailableAsync(CancellationToken cancellationToken)
    {
        HelperOutcome outcome = await CallAsync(
            HelperProtocol.Operations.Describe,
            new { },
            cancellationToken).ConfigureAwait(false);

        return outcome.Ok;
    }

    /// <summary>
    /// Ask the helper to do one thing.
    ///
    /// Never throws for the ordinary failures — no helper, a refusal, a timeout — because
    /// every one of them is something the caller has to report rather than crash on.
    /// </summary>
    public async Task<HelperOutcome> CallAsync<T>(
        string operation,
        T payload,
        CancellationToken cancellationToken)
    {
        if (!HelperProtocol.IsAllowed(operation))
        {
            // Checked on both sides on purpose. The helper is the boundary that matters, but
            // an agent that sends an operation it knows is not allowed has a bug worth
            // failing loudly rather than discovering from a refusal.
            throw new ArgumentException($"'{operation}' is not a helper operation.", nameof(operation));
        }

        using var pipe = new NamedPipeClientStream(
            ".",
            HelperProtocol.PipeName,
            PipeDirection.InOut,
            PipeOptions.Asynchronous);

        try
        {
            using var connecting = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            connecting.CancelAfter(ConnectTimeout);
            await pipe.ConnectAsync(connecting.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return HelperOutcome.Unavailable(
                "The WOLF privileged helper is not running on this PC, so operations that need " +
                "administrator rights are unavailable.");
        }
        catch (IOException ex)
        {
            _logger.LogWarning(ex, "Could not connect to the privileged helper.");
            return HelperOutcome.Unavailable("The WOLF privileged helper could not be reached.");
        }

        using var exchange = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        exchange.CancelAfter(RequestTimeout);

        try
        {
            return await ExchangeAsync(pipe, operation, payload, exchange.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            _logger.LogWarning("The privileged helper did not answer {Operation} in time.", operation);
            return new HelperOutcome(false, null, "timeout", "The privileged helper did not answer in time.");
        }
        catch (Exception ex) when (ex is IOException or InvalidOperationException or JsonException)
        {
            _logger.LogWarning(ex, "The exchange with the privileged helper failed.");
            return new HelperOutcome(false, null, "failed", "The privileged helper could not be reached.");
        }
    }

    private async Task<HelperOutcome> ExchangeAsync<T>(
        Stream pipe,
        string operation,
        T payload,
        CancellationToken cancellationToken)
    {
        var channel = new IpcChannel(pipe);

        await using IAsyncEnumerator<JsonDocument> messages =
            channel.ReadAsync(cancellationToken).GetAsyncEnumerator(cancellationToken);

        // The helper speaks first. Its nonce is what makes this request unrepeatable, so
        // there is nothing to send until it arrives.
        if (!await messages.MoveNextAsync().ConfigureAwait(false))
        {
            // The helper closed without a word, which is what it does to a caller it did not
            // recognise. Reported as a refusal rather than a fault: if this agent is not the
            // binary the helper expects, that is a real answer.
            return new HelperOutcome(
                false,
                null,
                "rejected",
                "The privileged helper refused this connection.");
        }

        string nonce;

        using (JsonDocument hello = messages.Current)
        {
            if (ReadString(hello.RootElement, "kind") != HelperHelloMessage.KindName)
            {
                return new HelperOutcome(false, null, "malformed", "The privileged helper said something unexpected.");
            }

            if (ReadInt(hello.RootElement, "version") != HelperProtocol.Version)
            {
                return new HelperOutcome(
                    false,
                    null,
                    "version-mismatch",
                    "The privileged helper on this PC is a different version to the agent.");
            }

            nonce = ReadString(hello.RootElement, "nonce") ?? string.Empty;
        }

        long sequence = Interlocked.Increment(ref _sequence);

        await channel.SendAsync(
            new HelperRequestMessage(
                HelperRequestMessage.KindName,
                HelperProtocol.Version,
                nonce,
                sequence,
                operation,
                JsonSerializer.SerializeToElement(payload, WolfIpc.Json)),
            cancellationToken).ConfigureAwait(false);

        if (!await messages.MoveNextAsync().ConfigureAwait(false))
        {
            return new HelperOutcome(false, null, "failed", "The privileged helper closed without answering.");
        }

        using JsonDocument response = messages.Current;
        JsonElement root = response.RootElement;

        bool ok = root.TryGetProperty("ok", out JsonElement okElement) &&
                  okElement.ValueKind == JsonValueKind.True;

        JsonElement? result = root.TryGetProperty("result", out JsonElement value) &&
                              value.ValueKind is not JsonValueKind.Null and not JsonValueKind.Undefined
            ? value.Clone()
            : null;

        return new HelperOutcome(ok, result, ReadString(root, "code"), ReadString(root, "message"));
    }

    private static string? ReadString(JsonElement element, string name) =>
        element.TryGetProperty(name, out JsonElement value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static int ReadInt(JsonElement element, string name) =>
        element.TryGetProperty(name, out JsonElement value) && value.TryGetInt32(out int parsed) ? parsed : 0;
}
