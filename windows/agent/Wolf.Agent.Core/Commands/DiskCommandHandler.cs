using System.Runtime.Versioning;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Wolf.Agent.Core.Privileged;
using Wolf.Agent.Core.Protocol;

namespace Wolf.Agent.Core.Commands;

/// <summary>
/// Disk health, which the agent cannot read on its own.
///
/// Everything here is a pass-through to the privileged helper. That is the point: the
/// process holding the network connection does not open device handles, and this handler
/// exists to translate a command into one allow-listed helper operation and its answer back.
///
/// The helper not being installed is an ordinary answer rather than a failure. It is a
/// separate service, it can be stopped, and a PC that has not been updated to a build that
/// includes it should say so plainly instead of reporting that the disks are fine.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class DiskCommandHandler : ICommandHandler
{
    private readonly HelperClient _helper;
    private readonly ILogger<DiskCommandHandler> _logger;

    public DiskCommandHandler(HelperClient helper, ILogger<DiskCommandHandler> logger)
    {
        _helper = helper;
        _logger = logger;
    }

    public IReadOnlyList<string> SupportedTypes { get; } = new[] { "disk.smart-health" };

    public async Task<CommandExecution> ExecuteAsync(
        CommandEnvelope envelope,
        CancellationToken cancellationToken)
    {
        if (envelope.Type != "disk.smart-health")
        {
            return CommandExecution.Failed("unsupported", $"'{envelope.Type}' is not a disk command.");
        }

        string? deviceId = envelope.Payload.TryGetProperty("deviceId", out JsonElement value) &&
                           value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

        HelperOutcome outcome = await _helper.CallAsync(
            HelperProtocol.Operations.DiskSmartHealth,
            new { deviceId },
            cancellationToken).ConfigureAwait(false);

        if (!outcome.Ok)
        {
            _logger.LogInformation(
                "Disk health is unavailable on this PC: {Code} {Message}",
                outcome.Code,
                outcome.Message);

            // Reported as a limitation rather than an error when the helper is simply not
            // there: nothing is broken, this PC just cannot answer the question yet.
            bool missing = outcome.Code is "helper-unavailable" or "rejected";
            string message = outcome.Message ?? "Disk health could not be read on this PC.";

            return missing
                ? Unavailable(message)
                : CommandExecution.Failed("disk-health-failed", message, "Try again in a moment.");
        }

        // The helper's shape and the protocol's are the same fields by design, so this is a
        // re-serialisation rather than a translation — one place for the two to drift is one
        // more than necessary.
        JsonElement result = outcome.Result ?? default;

        JsonElement disks = result.ValueKind == JsonValueKind.Object &&
                            result.TryGetProperty("disks", out JsonElement list)
            ? list
            : default;

        int count = disks.ValueKind == JsonValueKind.Array ? disks.GetArrayLength() : 0;
        _logger.LogInformation("Read health for {Count} drive(s) through the privileged helper.", count);

        return CommandExecution.Success(new
        {
            disks = disks.ValueKind == JsonValueKind.Array ? disks.Clone() : (object)Array.Empty<object>(),
            helperAvailable = true,
            unavailableReason = (string?)null,
            at = DateTimeOffset.UtcNow.ToString("o"),
        });
    }

    /// <summary>
    /// The answer when there is no helper: an empty list, and why it is empty.
    ///
    /// Deliberately a success rather than a failure. "This PC has no drives that will answer"
    /// and "WOLF cannot ask" are different things, and `helperAvailable` is the field that
    /// separates them — a caller that got an error instead would have to guess.
    /// </summary>
    private static CommandExecution Unavailable(string reason) =>
        CommandExecution.Success(new
        {
            disks = Array.Empty<object>(),
            helperAvailable = false,
            unavailableReason = reason,
            at = DateTimeOffset.UtcNow.ToString("o"),
        });
}
