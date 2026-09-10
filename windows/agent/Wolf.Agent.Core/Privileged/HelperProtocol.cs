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

        /// <summary>List the hardware devices Windows knows about. Read-only.</summary>
        public const string DeviceList = "device.list";

        /// <summary>
        /// Turn one device off or on.
        ///
        /// The only operation on this list that changes anything, and the reason the helper
        /// keeps refusals of its own rather than trusting the caller's risk classification.
        /// </summary>
        public const string DeviceSetEnabled = "device.set-enabled";

        /// <summary>List the Windows services on this machine. Read-only.</summary>
        public const string ServiceList = "service.list";

        /// <summary>
        /// Start, stop or restart one service.
        ///
        /// Refusals of the helper's own live in <see cref="Wolf.Agent.Helper"/>: a service
        /// that would cut the way back into the machine is not something a confirmation
        /// should be able to unlock.
        /// </summary>
        public const string ServiceControl = "service.control";

        /// <summary>
        /// Change when one service starts.
        ///
        /// Separate from starting and stopping because it survives a reboot, which makes it
        /// the more dangerous of the two: a service stopped by mistake comes back when the
        /// machine does, and a disabled one does not.
        /// </summary>
        public const string ServiceSetStartType = "service.set-start-type";

        /// <summary>List the scheduled tasks on this machine, hidden ones included. Read-only.</summary>
        public const string TaskList = "task.list";

        /// <summary>
        /// Enable, disable or run one scheduled task.
        ///
        /// Never register one and never delete one: a scheduled task is the first thing every
        /// piece of Windows malware creates, and there is no operation here that would.
        /// </summary>
        public const string TaskControl = "task.control";

        /// <summary>List what runs at sign-in, from every place Windows looks. Read-only.</summary>
        public const string StartupList = "startup.list";

        /// <summary>
        /// Turn one startup entry on or off.
        ///
        /// Written the way Task Manager writes it — the `StartupApproved` flag — so the entry
        /// itself survives and an operator can put back what they turned off. WOLF has no
        /// operation that adds a startup entry and none that removes one.
        /// </summary>
        public const string StartupSetEnabled = "startup.set-enabled";

        /// <summary>What this helper is and what it can do. Costs nothing and touches nothing.</summary>
        public const string Describe = "helper.describe";
    }

    /// <summary>True when the helper knows how to perform this operation.</summary>
    public static bool IsAllowed(string operation) =>
        operation is Operations.DiskSmartHealth
            or Operations.DeviceList
            or Operations.DeviceSetEnabled
            or Operations.ServiceList
            or Operations.ServiceControl
            or Operations.ServiceSetStartType
            or Operations.TaskList
            or Operations.TaskControl
            or Operations.StartupList
            or Operations.StartupSetEnabled
            or Operations.Describe;
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

/// <summary>One hardware device, as Windows describes it.</summary>
public sealed record HelperDevice(
    [property: JsonPropertyName("instanceId")] string InstanceId,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("deviceClass")] string? DeviceClass,
    [property: JsonPropertyName("manufacturer")] string? Manufacturer,
    [property: JsonPropertyName("state")] string State,
    [property: JsonPropertyName("problemCode")] int? ProblemCode,
    [property: JsonPropertyName("problem")] string? Problem,
    [property: JsonPropertyName("present")] bool Present,
    /// <summary>Which protection stops this device being disabled, or null when none does.</summary>
    [property: JsonPropertyName("protectedBy")] string? ProtectedBy);

/// <summary>The helper's answer to a device list request.</summary>
public sealed record HelperDeviceListResult(
    [property: JsonPropertyName("devices")] IReadOnlyList<HelperDevice> Devices);

/// <summary>What happened when a device was turned off or on.</summary>
public sealed record HelperDeviceResult(
    [property: JsonPropertyName("instanceId")] string InstanceId,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("ok")] bool Ok,
    /// <summary>What Windows reports after the change, not what was asked for.</summary>
    [property: JsonPropertyName("state")] string State,
    [property: JsonPropertyName("restartRequired")] bool RestartRequired,
    [property: JsonPropertyName("code")] string? Code,
    [property: JsonPropertyName("message")] string? Message);

/// <summary>One Windows service, as the service control manager describes it.</summary>
public sealed record HelperService(
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("displayName")] string DisplayName,
    /// <summary>running, stopped, starting, stopping, paused — as Windows reports it now.</summary>
    [property: JsonPropertyName("status")] string Status,
    /// <summary>automatic, automatic-delayed, manual, disabled, boot, system.</summary>
    [property: JsonPropertyName("startType")] string? StartType,
    /// <summary>The account it runs as, which is the fact that decides what it can reach.</summary>
    [property: JsonPropertyName("account")] string? Account,
    [property: JsonPropertyName("imagePath")] string? ImagePath,
    /// <summary>Whether Windows itself says the service accepts a stop.</summary>
    [property: JsonPropertyName("canStop")] bool CanStop,
    /// <summary>
    /// Which of WOLF's own protections covers this service, or null when none does.
    ///
    /// Carried in the listing so an operator sees what is off limits before they try it,
    /// rather than after. `Windows will not stop this` and `WOLF will not ask it to` are
    /// different facts and are reported separately.
    /// </summary>
    [property: JsonPropertyName("protectedBy")] string? ProtectedBy);

/// <summary>The helper's answer to a service list request.</summary>
public sealed record HelperServiceListResult(
    [property: JsonPropertyName("services")] IReadOnlyList<HelperService> Services);

/// <summary>What happened when a service was started, stopped, or reconfigured.</summary>
public sealed record HelperServiceResult(
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("displayName")] string DisplayName,
    [property: JsonPropertyName("ok")] bool Ok,
    /// <summary>What Windows reports afterwards, never what was asked for.</summary>
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("code")] string? Code,
    [property: JsonPropertyName("message")] string? Message);

/// <summary>One scheduled task, as the Windows task scheduler describes it.</summary>
public sealed record HelperTask(
    /// <summary>The full path, folder included: `\Microsoft\Windows\Defrag\ScheduledDefrag`.</summary>
    [property: JsonPropertyName("path")] string Path,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("enabled")] bool Enabled,
    /// <summary>unknown, disabled, queued, ready, running.</summary>
    [property: JsonPropertyName("state")] string State,
    [property: JsonPropertyName("lastRunAt")] string? LastRunAt,
    [property: JsonPropertyName("nextRunAt")] string? NextRunAt,
    /// <summary>The exit code of the last run. Zero is success; everything else is not.</summary>
    [property: JsonPropertyName("lastResult")] int LastResult,
    [property: JsonPropertyName("author")] string? Author,
    /// <summary>The account it runs as, which is the fact that decides what it can reach.</summary>
    [property: JsonPropertyName("account")] string? Account,
    /// <summary>What it actually runs. The first thing anybody investigating a machine reads.</summary>
    [property: JsonPropertyName("actions")] IReadOnlyList<string> Actions,
    /// <summary>Which of WOLF's protections covers this task, or null when none does.</summary>
    [property: JsonPropertyName("protectedBy")] string? ProtectedBy);

/// <summary>The helper's answer to a scheduled task list request.</summary>
public sealed record HelperTaskListResult(
    [property: JsonPropertyName("tasks")] IReadOnlyList<HelperTask> Tasks,
    [property: JsonPropertyName("truncated")] bool Truncated);

/// <summary>What happened when a scheduled task was enabled, disabled or run.</summary>
public sealed record HelperTaskResult(
    [property: JsonPropertyName("path")] string Path,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("ok")] bool Ok,
    /// <summary>What the scheduler says afterwards, never what was asked for.</summary>
    [property: JsonPropertyName("enabled")] bool Enabled,
    [property: JsonPropertyName("code")] string? Code,
    [property: JsonPropertyName("message")] string? Message);

/// <summary>One thing that runs when somebody signs in.</summary>
public sealed record HelperStartupEntry(
    [property: JsonPropertyName("name")] string Name,
    /// <summary>The command line, or the shortcut's path for a Startup folder entry.</summary>
    [property: JsonPropertyName("command")] string? Command,
    /// <summary>machine or user. Which of the two decides who it starts for.</summary>
    [property: JsonPropertyName("scope")] string Scope,
    /// <summary>run, run-once, or startup-folder — which of Windows' four places it came from.</summary>
    [property: JsonPropertyName("source")] string Source,
    /// <summary>Whose it is, for a user entry read from a mounted hive.</summary>
    [property: JsonPropertyName("user")] string? User,
    /// <summary>Whether Windows will actually run it, per the StartupApproved flag.</summary>
    [property: JsonPropertyName("enabled")] bool Enabled,
    [property: JsonPropertyName("protectedBy")] string? ProtectedBy);

/// <summary>The helper's answer to a startup list request.</summary>
public sealed record HelperStartupListResult(
    [property: JsonPropertyName("entries")] IReadOnlyList<HelperStartupEntry> Entries,
    [property: JsonPropertyName("truncated")] bool Truncated);

/// <summary>What happened when a startup entry was turned on or off.</summary>
public sealed record HelperStartupResult(
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("scope")] string Scope,
    [property: JsonPropertyName("ok")] bool Ok,
    [property: JsonPropertyName("enabled")] bool Enabled,
    [property: JsonPropertyName("code")] string? Code,
    [property: JsonPropertyName("message")] string? Message);
