using System.Runtime.Versioning;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Wolf.Agent.Core.Privileged;
using Wolf.Agent.Core.Protocol;

namespace Wolf.Agent.Core.Commands;

/// <summary>
/// Hardware devices: what is attached, and turning one off or on.
///
/// A pass-through to the privileged helper, like disk health — the process holding the
/// network connection does not call SetupAPI. The difference is that this one changes
/// things, and the changes are the least reversible WOLF makes: disable the wrong device on
/// a machine nobody is sitting at and there may be no way to put it back.
///
/// Which is why the safety rules live in the helper rather than here. The cloud classifies
/// risk so an operator is asked to confirm; the helper refuses outright the things no
/// confirmation should unlock. Both matter, and only the second survives an agent that has
/// been tampered with.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class DeviceCommandHandler : ICommandHandler
{
    private readonly HelperClient _helper;
    private readonly ILogger<DeviceCommandHandler> _logger;

    public DeviceCommandHandler(HelperClient helper, ILogger<DeviceCommandHandler> logger)
    {
        _helper = helper;
        _logger = logger;
    }

    public IReadOnlyList<string> SupportedTypes { get; } = new[] { "device.list", "device.set-enabled" };

    public async Task<CommandExecution> ExecuteAsync(
        CommandEnvelope envelope,
        CancellationToken cancellationToken)
    {
        return envelope.Type switch
        {
            "device.list" => await ListAsync(envelope.Payload, cancellationToken).ConfigureAwait(false),
            "device.set-enabled" => await SetEnabledAsync(envelope.Payload, cancellationToken).ConfigureAwait(false),
            _ => CommandExecution.Failed("unsupported", $"'{envelope.Type}' is not a device command."),
        };
    }

    private async Task<CommandExecution> ListAsync(JsonElement payload, CancellationToken cancellationToken)
    {
        string? deviceClass = ReadString(payload, "deviceClass");
        bool includeAbsent = payload.TryGetProperty("includeAbsent", out JsonElement absent) &&
                             absent.ValueKind == JsonValueKind.True;

        HelperOutcome outcome = await _helper.CallAsync(
            HelperProtocol.Operations.DeviceList,
            new { deviceClass, includeAbsent },
            cancellationToken).ConfigureAwait(false);

        if (!outcome.Ok)
        {
            string message = outcome.Message ?? "The device list could not be read on this PC.";
            _logger.LogInformation("Device list unavailable: {Code} {Message}", outcome.Code, message);

            // An empty list and a reason, rather than an error. "This PC has no devices" and
            // "WOLF cannot ask" are different things, and `helperAvailable` is what separates
            // them for a caller that would otherwise have to guess.
            return CommandExecution.Success(new
            {
                devices = Array.Empty<object>(),
                helperAvailable = false,
                unavailableReason = message,
                at = DateTimeOffset.UtcNow.ToString("o"),
            });
        }

        JsonElement devices = ReadArray(outcome.Result, "devices");
        int count = devices.ValueKind == JsonValueKind.Array ? devices.GetArrayLength() : 0;
        _logger.LogInformation("Listed {Count} device(s) through the privileged helper.", count);

        return CommandExecution.Success(new
        {
            devices = devices.ValueKind == JsonValueKind.Array ? devices.Clone() : (object)Array.Empty<object>(),
            helperAvailable = true,
            unavailableReason = (string?)null,
            at = DateTimeOffset.UtcNow.ToString("o"),
        });
    }

    private async Task<CommandExecution> SetEnabledAsync(JsonElement payload, CancellationToken cancellationToken)
    {
        string? instanceId = ReadString(payload, "instanceId");
        string? expectedName = ReadString(payload, "expectedName");

        if (instanceId is null || expectedName is null)
        {
            return CommandExecution.Failed(
                "invalid-payload",
                "A device change needs both an instance id and the name it was last seen under.");
        }

        bool enabled = payload.TryGetProperty("enabled", out JsonElement enabledElement) &&
                       enabledElement.ValueKind == JsonValueKind.True;

        HelperOutcome outcome = await _helper.CallAsync(
            HelperProtocol.Operations.DeviceSetEnabled,
            new { instanceId, enabled, expectedName },
            cancellationToken).ConfigureAwait(false);

        if (!outcome.Ok)
        {
            string message = outcome.Message ?? "The device could not be changed on this PC.";

            return outcome.Code is "helper-unavailable" or "rejected"
                ? CommandExecution.Limitation("capability-unavailable", message, "Install or start the WOLF privileged helper.")
                : CommandExecution.Failed("device-change-failed", message, "Try again in a moment.");
        }

        JsonElement result = outcome.Result ?? default;
        bool ok = result.ValueKind == JsonValueKind.Object &&
                  result.TryGetProperty("ok", out JsonElement okElement) &&
                  okElement.ValueKind == JsonValueKind.True;

        string? code = ReadString(result, "code");
        string? message2 = ReadString(result, "message");
        string name = ReadString(result, "name") ?? expectedName;

        if (!ok)
        {
            _logger.LogInformation("The helper refused a device change: {Code} {Message}", code, message2);

            // A protection is a limitation rather than a failure: WOLF is working exactly as
            // intended, and the operator needs to know it will not be talked round.
            return code is "device-protected"
                ? CommandExecution.Limitation(
                    "device-protected",
                    message2 ?? "WOLF will not disable that device remotely.",
                    "Disable it from the PC itself if it really needs to be off.")
                : CommandExecution.Failed(
                    code ?? "device-change-failed",
                    message2 ?? "The device could not be changed.",
                    "Refresh the device list and try again.");
        }

        bool restartRequired = result.TryGetProperty("restartRequired", out JsonElement restart) &&
                               restart.ValueKind == JsonValueKind.True;

        _logger.LogInformation(
            "{Action} {Name}{Restart}.",
            enabled ? "Enabled" : "Disabled",
            name,
            restartRequired ? " (a restart is needed before it takes effect)" : string.Empty);

        return CommandExecution.Success(new
        {
            instanceId,
            name,
            requestedEnabled = enabled,
            state = ReadString(result, "state") ?? "unknown",
            restartRequired,
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
