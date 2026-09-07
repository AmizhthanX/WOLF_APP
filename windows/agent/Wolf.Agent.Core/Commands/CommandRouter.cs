using System.Diagnostics;
using Microsoft.Extensions.Logging;
using Wolf.Agent.Core.Protocol;
using Wolf.Agent.Core.Storage;

namespace Wolf.Agent.Core.Commands;

/// <summary>Outcome of running one command: exactly one of a result or a failure.</summary>
public sealed record CommandExecution(object? Result, CommandFailurePayload? Failure)
{
    public static CommandExecution Success(object result) => new(result, null);

    public static CommandExecution Failed(
        string code,
        string message,
        string? recommendedAction = null) =>
        new(null, new CommandFailurePayload(code, message, Limitation: false, recommendedAction));

    /// <summary>
    /// The operation is not possible on this machine or under this Windows configuration.
    /// This is reported distinctly from a failure so the UI can say "Windows does not allow
    /// this here" rather than implying WOLF broke.
    /// </summary>
    public static CommandExecution Limitation(
        string code,
        string message,
        string? recommendedAction = null) =>
        new(null, new CommandFailurePayload(code, message, Limitation: true, recommendedAction));
}

public interface ICommandHandler
{
    IReadOnlyList<string> SupportedTypes { get; }

    Task<CommandExecution> ExecuteAsync(CommandEnvelope envelope, CancellationToken cancellationToken);
}

/// <summary>
/// Dispatches a command to its handler.
///
/// The router enforces three things no handler should have to repeat: a command past its
/// expiry is refused rather than run late, a command type with no handler is refused
/// explicitly rather than silently ignored, and a repeated idempotency key returns the
/// original outcome instead of performing the action twice.
/// </summary>
public sealed class CommandRouter
{
    private readonly Dictionary<string, ICommandHandler> _handlers = new(StringComparer.Ordinal);
    private readonly AgentStore _store;
    private readonly ILogger<CommandRouter> _logger;
    private readonly string _agentVersion;

    public CommandRouter(
        IEnumerable<ICommandHandler> handlers,
        AgentStore store,
        string agentVersion,
        ILogger<CommandRouter> logger)
    {
        _store = store;
        _agentVersion = agentVersion;
        _logger = logger;

        foreach (ICommandHandler handler in handlers)
        {
            foreach (string type in handler.SupportedTypes)
            {
                _handlers[type] = handler;
            }
        }
    }

    /// <summary>Command types this build can execute, advertised to the cloud at connect time.</summary>
    public IReadOnlyList<string> SupportedTypes => _handlers.Keys.Order(StringComparer.Ordinal).ToList();

    public async Task<CommandResultPayload> ExecuteAsync(
        CommandEnvelope envelope,
        CancellationToken cancellationToken)
    {
        DateTimeOffset startedAt = DateTimeOffset.UtcNow;

        // A command that arrived late is dead. Running it now would mean, for example, a
        // shutdown firing at an arbitrary moment after connectivity returned.
        if (startedAt > envelope.ExpiresAt)
        {
            _logger.LogWarning(
                "Refused command {CommandId} ({Type}): it expired at {ExpiresAt}.",
                envelope.CommandId,
                envelope.Type,
                envelope.ExpiresAt);

            return Failure(
                envelope,
                startedAt,
                new CommandFailurePayload(
                    "expired",
                    "The command expired before it reached this PC and was not run.",
                    Limitation: false,
                    "Issue the command again."));
        }

        if (_store.TryGetCompletedCommand(envelope.CommandId, out CommandResultPayload? previous))
        {
            _logger.LogInformation(
                "Command {CommandId} was already executed; returning the original outcome.",
                envelope.CommandId);
            return previous!;
        }

        if (!_handlers.TryGetValue(envelope.Type, out ICommandHandler? handler))
        {
            return Failure(
                envelope,
                startedAt,
                new CommandFailurePayload(
                    "unsupported-command",
                    $"This agent does not implement \"{envelope.Type}\".",
                    Limitation: false,
                    "Update the WOLF agent on this PC."));
        }

        CommandExecution execution;
        try
        {
            execution = await handler.ExecuteAsync(envelope, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (UnauthorizedAccessException ex)
        {
            execution = CommandExecution.Limitation(
                "access-denied",
                "Windows denied access for this operation.",
                "The operation may need the WOLF privileged helper, which is not installed.");
            _logger.LogWarning(ex, "Access denied running {Type}.", envelope.Type);
        }
        catch (Exception ex)
        {
            // The message is included so the operator sees a real cause, but the stack trace
            // stays in the local log rather than travelling to the cloud.
            execution = CommandExecution.Failed("agent-error", ex.Message, "Check the WOLF agent log on this PC.");
            _logger.LogError(ex, "Command {CommandId} ({Type}) failed.", envelope.CommandId, envelope.Type);
        }

        var payload = new CommandResultPayload(
            CommandId: envelope.CommandId,
            Status: execution.Failure is null ? "completed" : "failed",
            StartedAt: startedAt.ToString("o"),
            CompletedAt: DateTimeOffset.UtcNow.ToString("o"),
            Failure: execution.Failure,
            Result: execution.Result,
            AgentVersion: _agentVersion);

        _store.RecordCompletedCommand(envelope.CommandId, envelope.IdempotencyKey, payload);
        return payload;
    }

    private CommandResultPayload Failure(
        CommandEnvelope envelope,
        DateTimeOffset startedAt,
        CommandFailurePayload failure) =>
        new(
            CommandId: envelope.CommandId,
            Status: "failed",
            StartedAt: startedAt.ToString("o"),
            CompletedAt: DateTimeOffset.UtcNow.ToString("o"),
            Failure: failure,
            Result: null,
            AgentVersion: _agentVersion);
}
