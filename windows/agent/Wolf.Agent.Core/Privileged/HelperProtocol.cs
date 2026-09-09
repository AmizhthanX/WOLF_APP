using System.Text.Json.Serialization;

namespace Wolf.Agent.Core.Privileged;

/// <summary>
/// The contract between the agent and the privileged helper.
///
/// Deliberately tiny. The helper's whole reason for existing is that the process holding the
/// network connection should not also be the process holding raw device handles and, later,
/// a credential provider — so its surface is an allow-list of named operations with typed
/// payloads, and adding to it is a deliberate act. There is no "run this" operation and
/// there is not going to be one.
///
/// Both processes run as LocalSystem, so this is a boundary of *surface* rather than of
/// privilege, and worth saying plainly: it does not stop an attacker who is already SYSTEM.
/// What it stops is a bug in the agent's message parsing turning into arbitrary privileged
/// action, because the only thing on the other side of this pipe is the list below.
/// </summary>
public static class HelperProtocol
{
    /// <summary>The pipe the helper listens on.</summary>
    public const string PipeName = "wolf-agent-helper";

    /// <summary>Contract version. A mismatch ends the connection rather than being guessed at.</summary>
    public const int Version = 1;

    /// <summary>Every operation the helper will perform. Anything else is refused.</summary>
    public static class Operations
    {
        /// <summary>Read SMART health for one drive, or for all of them.</summary>
        public const string DiskSmartHealth = "disk.smart-health";

        /// <summary>What this helper is and what it can do. Costs nothing and touches nothing.</summary>
        public const string Describe = "helper.describe";
    }

    /// <summary>True when the helper knows how to perform this operation.</summary>
    public static bool IsAllowed(string operation) =>
        operation is Operations.DiskSmartHealth or Operations.Describe;
}

/// <summary>
/// The helper's opening message, sent before it will accept anything.
///
/// The nonce is what makes a captured request useless on a later connection: every request
/// has to carry it back, and it is different every time.
/// </summary>
public sealed record HelperHelloMessage(
    [property: JsonPropertyName("kind")] string Kind,
    [property: JsonPropertyName("version")] int Version,
    [property: JsonPropertyName("helperVersion")] string HelperVersion,
    [property: JsonPropertyName("nonce")] string Nonce)
{
    public const string KindName = "helper.hello";
}

/// <summary>One request from the agent to the helper.</summary>
public sealed record HelperRequestMessage(
    [property: JsonPropertyName("kind")] string Kind,
    [property: JsonPropertyName("version")] int Version,
    /// <summary>Echoed from the hello. A request without the current nonce is refused.</summary>
    [property: JsonPropertyName("nonce")] string Nonce,
    /// <summary>Strictly increasing within a connection, so a request cannot be replayed.</summary>
    [property: JsonPropertyName("sequence")] long Sequence,
    [property: JsonPropertyName("operation")] string Operation,
    [property: JsonPropertyName("payload")] System.Text.Json.JsonElement Payload)
{
    public const string KindName = "helper.request";
}

/// <summary>One answer, successful or not. Every request gets exactly one.</summary>
public sealed record HelperResponseMessage(
    [property: JsonPropertyName("kind")] string Kind,
    [property: JsonPropertyName("sequence")] long Sequence,
    [property: JsonPropertyName("ok")] bool Ok,
    /// <summary>Machine-readable refusal code; null when the operation succeeded.</summary>
    [property: JsonPropertyName("code")] string? Code,
    /// <summary>What went wrong, in the operator's terms; null when it did not.</summary>
    [property: JsonPropertyName("message")] string? Message,
    [property: JsonPropertyName("result")] System.Text.Json.JsonElement? Result)
{
    public const string KindName = "helper.response";
}

/// <summary>What the helper says about itself.</summary>
public sealed record HelperDescription(
    [property: JsonPropertyName("helperVersion")] string HelperVersion,
    [property: JsonPropertyName("operations")] IReadOnlyList<string> Operations,
    /// <summary>The account the helper is running as, so the agent can log what it is talking to.</summary>
    [property: JsonPropertyName("account")] string Account);

/// <summary>SMART health for one physical drive, as the helper read it.</summary>
public sealed record HelperDiskHealth(
    [property: JsonPropertyName("deviceId")] string DeviceId,
    [property: JsonPropertyName("model")] string? Model,
    [property: JsonPropertyName("serialNumber")] string? SerialNumber,
    [property: JsonPropertyName("firmware")] string? Firmware,
    [property: JsonPropertyName("sizeBytes")] long? SizeBytes,
    [property: JsonPropertyName("busType")] string? BusType,
    [property: JsonPropertyName("solidState")] bool? SolidState,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("summary")] string Summary,
    [property: JsonPropertyName("temperatureCelsius")] double? TemperatureCelsius,
    [property: JsonPropertyName("powerOnHours")] double? PowerOnHours,
    [property: JsonPropertyName("attributes")] IReadOnlyList<HelperSmartAttribute> Attributes);

/// <summary>One SMART attribute, as the drive reported it.</summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage(
    "Naming",
    "CA1711:Identifiers should not have incorrect suffix",
    Justification =
        "SMART attribute is the term the drives, the specification and every tool use. " +
        "Renaming it to avoid resembling System.Attribute would trade a name every reader " +
        "knows for one nobody does.")]
public sealed record HelperSmartAttribute(
    [property: JsonPropertyName("id")] int Id,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("value")] int Value,
    [property: JsonPropertyName("worst")] int Worst,
    [property: JsonPropertyName("threshold")] int Threshold,
    [property: JsonPropertyName("raw")] double Raw,
    [property: JsonPropertyName("prefail")] bool Prefail,
    [property: JsonPropertyName("failing")] bool Failing);

/// <summary>The helper's answer to a disk health request.</summary>
public sealed record HelperDiskHealthResult(
    [property: JsonPropertyName("disks")] IReadOnlyList<HelperDiskHealth> Disks);
