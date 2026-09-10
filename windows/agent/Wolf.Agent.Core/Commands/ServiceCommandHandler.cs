using System.Runtime.Versioning;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Wolf.Agent.Core.Privileged;
using Wolf.Agent.Core.Protocol;

namespace Wolf.Agent.Core.Commands;

/// <summary>
/// Windows services: what is installed, and starting, stopping or reconfiguring one.
///
/// A pass-through to the privileged helper, like devices and disk health. The process holding
/// the network connection does not talk to the service control manager.
///
/// **This is deliberately on the command path rather than the data channel**, which is the
/// opposite of the terminal and the file manager, and the reason is worth stating. Those two
/// carry content that must never be stored, so they go where no server can see them. A service
/// change carries no content at all — it is a name and a verb — and what matters about it is
/// the opposite: that it is classified for risk, confirmed, re-authenticated where the risk
/// warrants, and written to an audit log somebody can read afterwards. That machinery lives in
/// the cloud, and routing service control around it to save a hop would be trading the only
/// property that makes it accountable for one it does not need.
///
/// The safety rules live in the helper rather than here, for the same reason they do for
/// devices: the cloud classifies risk so an operator is asked to confirm, and the helper
/// refuses outright the things no confirmation should unlock. Only the second survives an
/// agent that has been tampered with.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class ServiceCommandHandler : ICommandHandler
{
    private readonly HelperClient _helper;
    private readonly ILogger<ServiceCommandHandler> _logger;

    public ServiceCommandHandler(HelperClient helper, ILogger<ServiceCommandHandler> logger)
    {
        _helper = helper;
        _logger = logger;
    }

    public IReadOnlyList<string> SupportedTypes { get; } = new[]
    {
        "service.list",
        "service.control",
        "service.set-start-type",
    };

    public async Task<CommandExecution> ExecuteAsync(
        CommandEnvelope envelope,
        CancellationToken cancellationToken)
    {
        return envelope.Type switch
        {
            "service.list" => await ListAsync(envelope.Payload, cancellationToken).ConfigureAwait(false),
            "service.control" => await ControlAsync(envelope.Payload, cancellationToken).ConfigureAwait(false),
            "service.set-start-type" =>
                await SetStartTypeAsync(envelope.Payload, cancellationToken).ConfigureAwait(false),
            _ => CommandExecution.Failed("unsupported", $"'{envelope.Type}' is not a service command."),
        };
    }

    private async Task<CommandExecution> ListAsync(JsonElement payload, CancellationToken cancellationToken)
    {
        string? search = ReadString(payload, "search");

        HelperOutcome outcome = await _helper.CallAsync(
            HelperProtocol.Operations.ServiceList,
            new { search },
            cancellationToken).ConfigureAwait(false);

        if (!outcome.Ok)
        {
            string message = outcome.Message ?? "The service list could not be read on this PC.";
            _logger.LogInformation("Service list unavailable: {Code} {Message}", outcome.Code, message);

            // An empty list and a reason, rather than an error. "This PC has no services" is
            // not a thing that happens, so a caller seeing an empty list needs to be told the
            // difference between that and "WOLF cannot ask".
            return CommandExecution.Success(new
            {
                services = Array.Empty<object>(),
                helperAvailable = false,
                unavailableReason = message,
                at = DateTimeOffset.UtcNow.ToString("o"),
            });
        }

        JsonElement services = ReadArray(outcome.Result, "services");
        int count = services.ValueKind == JsonValueKind.Array ? services.GetArrayLength() : 0;
        _logger.LogInformation("Listed {Count} service(s) through the privileged helper.", count);

        return CommandExecution.Success(new
        {
            services = services.ValueKind == JsonValueKind.Array ? services.Clone() : (object)Array.Empty<object>(),
            helperAvailable = true,
            unavailableReason = (string?)null,
            at = DateTimeOffset.UtcNow.ToString("o"),
        });
    }

    private async Task<CommandExecution> ControlAsync(JsonElement payload, CancellationToken cancellationToken)
    {
        string? name = ReadString(payload, "name");
        string? action = ReadString(payload, "action");
        string? expected = ReadString(payload, "expectedDisplayName");

        if (name is null || action is null || expected is null)
        {
            return CommandExecution.Failed(
                "invalid-payload",
                "A service change needs a name, an action, and the display name it was last seen under.");
        }

        HelperOutcome outcome = await _helper.CallAsync(
            HelperProtocol.Operations.ServiceControl,
            new { name, action, expectedDisplayName = expected },
            cancellationToken).ConfigureAwait(false);

        return Interpret(outcome, name, expected, $"{action} that service");
    }

    private async Task<CommandExecution> SetStartTypeAsync(JsonElement payload, CancellationToken cancellationToken)
    {
        string? name = ReadString(payload, "name");
        string? startType = ReadString(payload, "startType");
        string? expected = ReadString(payload, "expectedDisplayName");

        if (name is null || startType is null || expected is null)
        {
            return CommandExecution.Failed(
                "invalid-payload",
                "A start-type change needs a name, a start type, and the display name it was last seen under.");
        }

        HelperOutcome outcome = await _helper.CallAsync(
            HelperProtocol.Operations.ServiceSetStartType,
            new { name, startType, expectedDisplayName = expected },
            cancellationToken).ConfigureAwait(false);

        return Interpret(outcome, name, expected, "change how that service starts");
    }

    /// <summary>
    /// Turn the helper's answer into something the operator can act on.
    ///
    /// The distinction that matters here is between a *failure* and a *limitation*. WOLF
    /// refusing to stop a service is the product working exactly as designed, and telling an
    /// operator to try again would be wrong twice over — it will not work, and it suggests the
    /// refusal is the sort of thing that can be talked round.
    /// </summary>
    private CommandExecution Interpret(
        HelperOutcome outcome,
        string name,
        string expected,
        string attempted)
    {
        if (!outcome.Ok)
        {
            string message = outcome.Message ?? $"WOLF could not {attempted} on this PC.";

            return outcome.Code is "helper-unavailable" or "rejected"
                ? CommandExecution.Limitation(
                    "capability-unavailable",
                    message,
                    "Install or start the WOLF privileged helper.")
                : CommandExecution.Failed("service-change-failed", message, "Try again in a moment.");
        }

        JsonElement result = outcome.Result ?? default;
        bool ok = result.ValueKind == JsonValueKind.Object &&
                  result.TryGetProperty("ok", out JsonElement okElement) &&
                  okElement.ValueKind == JsonValueKind.True;

        string? code = ReadString(result, "code");
        string? message2 = ReadString(result, "message");
        string status = ReadString(result, "status") ?? "unknown";

        if (!ok)
        {
            _logger.LogInformation("The helper refused a service change: {Code} {Message}", code, message2);

            return code switch
            {
                // WOLF's own refusals. Reported as limitations, with the honest alternative
                // rather than an invitation to retry.
                "wolf-service" or "system-critical" or "network-critical" =>
                    CommandExecution.Limitation(
                        code,
                        message2 ?? "WOLF will not do that to that service remotely.",
                        "Do it from the PC itself if it really has to happen."),

                // Windows' refusal, which is a different fact and a different next step.
                "not-stoppable" =>
                    CommandExecution.Limitation(
                        code,
                        message2 ?? "Windows does not allow that service to be stopped.",
                        "Nothing on this PC can stop it while Windows is running."),

                "name-mismatch" =>
                    CommandExecution.Failed(
                        code,
                        message2 ?? "That service is not the one it was when the list was read.",
                        "Refresh the service list and try again."),

                _ => CommandExecution.Failed(
                    code ?? "service-change-failed",
                    message2 ?? $"WOLF could not {attempted}.",
                    "Refresh the service list and try again."),
            };
        }

        _logger.LogInformation("Service {Name} is now {Status}.", name, status);

        return CommandExecution.Success(new
        {
            name,
            displayName = ReadString(result, "displayName") ?? expected,
            // What Windows reports afterwards, never what was asked for. A service that was
            // told to stop and did not is the case this exists to make visible.
            status,
            note = message2,
            at = DateTimeOffset.UtcNow.ToString("o"),
        });
    }

    private static string? ReadString(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object &&
        element.TryGetProperty(name, out JsonElement value) &&
        value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static JsonElement ReadArray(JsonElement? source, string name) =>
        source is { ValueKind: JsonValueKind.Object } element &&
        element.TryGetProperty(name, out JsonElement value)
            ? value
            : default;
}
