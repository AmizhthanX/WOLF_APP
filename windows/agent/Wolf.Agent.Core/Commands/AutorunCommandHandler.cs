using System.Runtime.Versioning;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Wolf.Agent.Core.Privileged;
using Wolf.Agent.Core.Protocol;

namespace Wolf.Agent.Core.Commands;

/// <summary>
/// Scheduled tasks and startup items — what a machine does on its own.
///
/// Together with services these are the three ways something runs without anybody asking, and
/// they are the three places anybody investigating a machine looks first. That is the reason
/// the read commands exist at all, and it is why they are audited despite changing nothing:
/// "what runs on this machine when nobody is watching" is a useful question and also exactly
/// what somebody planning to abuse it wants to know.
///
/// A pass-through to the privileged helper, on the command path rather than the data channel,
/// for the same reasons as <see cref="ServiceCommandHandler"/>: it needs administrator, and
/// what matters about a change here is that it is confirmed and audited rather than that it is
/// private.
///
/// **WOLF creates neither.** There is no command that registers a scheduled task, and none
/// that adds a startup entry — nor any that deletes one. Those two mechanisms are how Windows
/// persistence works, and a remote-management tool that can install either is a remote
/// persistence tool whatever else it is. Disabling a startup entry writes the same approval
/// flag Task Manager writes, leaving the entry intact so it can be put back.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class AutorunCommandHandler : ICommandHandler
{
    private readonly HelperClient _helper;
    private readonly ILogger<AutorunCommandHandler> _logger;

    public AutorunCommandHandler(HelperClient helper, ILogger<AutorunCommandHandler> logger)
    {
        _helper = helper;
        _logger = logger;
    }

    public IReadOnlyList<string> SupportedTypes { get; } = new[]
    {
        "task.list",
        "task.control",
        "startup.list",
        "startup.set-enabled",
    };

    public async Task<CommandExecution> ExecuteAsync(
        CommandEnvelope envelope,
        CancellationToken cancellationToken)
    {
        return envelope.Type switch
        {
            "task.list" => await ListTasksAsync(envelope.Payload, cancellationToken).ConfigureAwait(false),
            "task.control" => await ControlTaskAsync(envelope.Payload, cancellationToken).ConfigureAwait(false),
            "startup.list" => await ListStartupAsync(cancellationToken).ConfigureAwait(false),
            "startup.set-enabled" =>
                await SetStartupEnabledAsync(envelope.Payload, cancellationToken).ConfigureAwait(false),
            _ => CommandExecution.Failed("unsupported", $"'{envelope.Type}' is not an autorun command."),
        };
    }

    private async Task<CommandExecution> ListTasksAsync(JsonElement payload, CancellationToken cancellationToken)
    {
        HelperOutcome outcome = await _helper.CallAsync(
            HelperProtocol.Operations.TaskList,
            new { search = ReadString(payload, "search") },
            cancellationToken).ConfigureAwait(false);

        if (!outcome.Ok)
        {
            return Unavailable("tasks", outcome, "The scheduled task list could not be read on this PC.");
        }

        JsonElement tasks = ReadArray(outcome.Result, "tasks");
        _logger.LogInformation(
            "Listed {Count} scheduled task(s) through the privileged helper.",
            tasks.ValueKind == JsonValueKind.Array ? tasks.GetArrayLength() : 0);

        return CommandExecution.Success(new
        {
            tasks = tasks.ValueKind == JsonValueKind.Array ? tasks.Clone() : (object)Array.Empty<object>(),
            truncated = ReadBool(outcome.Result, "truncated"),
            helperAvailable = true,
            unavailableReason = (string?)null,
            at = DateTimeOffset.UtcNow.ToString("o"),
        });
    }

    private async Task<CommandExecution> ControlTaskAsync(JsonElement payload, CancellationToken cancellationToken)
    {
        string? path = ReadString(payload, "path");
        string? action = ReadString(payload, "action");
        string? expected = ReadString(payload, "expectedName");

        if (path is null || action is null || expected is null)
        {
            return CommandExecution.Failed(
                "invalid-payload",
                "A task change needs a path, an action, and the name it was last seen under.");
        }

        HelperOutcome outcome = await _helper.CallAsync(
            HelperProtocol.Operations.TaskControl,
            new { path, action, expectedName = expected },
            cancellationToken).ConfigureAwait(false);

        if (!outcome.Ok)
        {
            return HelperFailed(outcome, $"WOLF could not {action} that scheduled task.");
        }

        JsonElement result = outcome.Result ?? default;

        if (!ReadBool(outcome.Result, "ok"))
        {
            return Refused(
                ReadString(result, "code"),
                ReadString(result, "message"),
                "WOLF will not disable that scheduled task remotely.",
                "Refresh the task list and try again.");
        }

        bool enabled = ReadBool(outcome.Result, "enabled");
        _logger.LogInformation("A scheduled task was {Action}d; it is now {State}.", action, enabled ? "enabled" : "disabled");

        return CommandExecution.Success(new
        {
            path,
            name = ReadString(result, "name") ?? expected,
            // What the scheduler says afterwards, never what was asked for.
            enabled,
            at = DateTimeOffset.UtcNow.ToString("o"),
        });
    }

    private async Task<CommandExecution> ListStartupAsync(CancellationToken cancellationToken)
    {
        HelperOutcome outcome = await _helper.CallAsync(
            HelperProtocol.Operations.StartupList,
            new { },
            cancellationToken).ConfigureAwait(false);

        if (!outcome.Ok)
        {
            return Unavailable("entries", outcome, "The startup list could not be read on this PC.");
        }

        JsonElement entries = ReadArray(outcome.Result, "entries");
        _logger.LogInformation(
            "Listed {Count} startup entr(ies) through the privileged helper.",
            entries.ValueKind == JsonValueKind.Array ? entries.GetArrayLength() : 0);

        return CommandExecution.Success(new
        {
            entries = entries.ValueKind == JsonValueKind.Array ? entries.Clone() : (object)Array.Empty<object>(),
            truncated = ReadBool(outcome.Result, "truncated"),
            helperAvailable = true,
            unavailableReason = (string?)null,
            at = DateTimeOffset.UtcNow.ToString("o"),
        });
    }

    private async Task<CommandExecution> SetStartupEnabledAsync(JsonElement payload, CancellationToken cancellationToken)
    {
        string? name = ReadString(payload, "name");
        string? scope = ReadString(payload, "scope");
        string? source = ReadString(payload, "source");

        if (name is null || scope is null || source is null)
        {
            return CommandExecution.Failed(
                "invalid-payload",
                "A startup change needs a name, a scope, and which of Windows' places it came from.");
        }

        bool enabled = payload.TryGetProperty("enabled", out JsonElement element) &&
                       element.ValueKind == JsonValueKind.True;

        HelperOutcome outcome = await _helper.CallAsync(
            HelperProtocol.Operations.StartupSetEnabled,
            new { name, scope, source, enabled },
            cancellationToken).ConfigureAwait(false);

        if (!outcome.Ok)
        {
            return HelperFailed(outcome, "WOLF could not change that startup entry.");
        }

        JsonElement result = outcome.Result ?? default;

        if (!ReadBool(outcome.Result, "ok"))
        {
            return Refused(
                ReadString(result, "code"),
                ReadString(result, "message"),
                "WOLF will not disable that startup entry remotely.",
                "Refresh the startup list and try again.");
        }

        _logger.LogInformation(
            "A {Scope} startup entry was {Action}.",
            scope,
            enabled ? "enabled" : "disabled");

        return CommandExecution.Success(new
        {
            name = ReadString(result, "name") ?? name,
            scope,
            source,
            enabled = ReadBool(outcome.Result, "enabled"),
            at = DateTimeOffset.UtcNow.ToString("o"),
        });
    }

    /// <summary>
    /// An empty list and a reason, rather than an error.
    ///
    /// Every Windows machine has scheduled tasks and most have startup entries, so a caller
    /// seeing an empty list needs to be told whether that is the machine or whether WOLF could
    /// not ask.
    /// </summary>
    private CommandExecution Unavailable(string field, HelperOutcome outcome, string fallback)
    {
        string message = outcome.Message ?? fallback;
        _logger.LogInformation("Autorun list unavailable: {Code} {Message}", outcome.Code, message);

        return CommandExecution.Success(field == "tasks"
            ? new
            {
                tasks = Array.Empty<object>(),
                truncated = false,
                helperAvailable = false,
                unavailableReason = message,
                at = DateTimeOffset.UtcNow.ToString("o"),
            }
            : (object)new
            {
                entries = Array.Empty<object>(),
                truncated = false,
                helperAvailable = false,
                unavailableReason = message,
                at = DateTimeOffset.UtcNow.ToString("o"),
            });
    }

    private static CommandExecution HelperFailed(HelperOutcome outcome, string fallback)
    {
        string message = outcome.Message ?? fallback;

        return outcome.Code is "helper-unavailable" or "rejected"
            ? CommandExecution.Limitation(
                "capability-unavailable", message, "Install or start the WOLF privileged helper.")
            : CommandExecution.Failed("autorun-change-failed", message, "Try again in a moment.");
    }

    /// <summary>
    /// Turn the helper's refusal into something the operator can act on.
    ///
    /// A protection is a limitation rather than a failure: WOLF is working exactly as
    /// intended, and telling somebody to retry would be wrong twice over — it will not work,
    /// and it suggests the refusal is the sort of thing that can be talked round.
    /// </summary>
    private CommandExecution Refused(string? code, string? message, string protectedFallback, string retryAdvice)
    {
        _logger.LogInformation("The helper refused an autorun change: {Code} {Message}", code, message);

        return code switch
        {
            "wolf-task" or "wolf-startup" or "system-critical" =>
                CommandExecution.Limitation(
                    code,
                    message ?? protectedFallback,
                    "Do it from the PC itself if it really has to happen."),

            "name-mismatch" =>
                CommandExecution.Failed(
                    code,
                    message ?? "That is not the same one it was when the list was read.",
                    retryAdvice),

            _ => CommandExecution.Failed(code ?? "autorun-change-failed", message ?? protectedFallback, retryAdvice),
        };
    }

    private static string? ReadString(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object &&
        element.TryGetProperty(name, out JsonElement value) &&
        value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static bool ReadBool(JsonElement? source, string name) =>
        source is { ValueKind: JsonValueKind.Object } element &&
        element.TryGetProperty(name, out JsonElement value) &&
        value.ValueKind == JsonValueKind.True;

    private static JsonElement ReadArray(JsonElement? source, string name) =>
        source is { ValueKind: JsonValueKind.Object } element &&
        element.TryGetProperty(name, out JsonElement value)
            ? value
            : default;
}
