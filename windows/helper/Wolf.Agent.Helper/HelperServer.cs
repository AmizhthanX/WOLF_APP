using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Wolf.Agent.Core.Ipc;
using Wolf.Agent.Core.Privileged;

namespace Wolf.Agent.Helper;

/// <summary>
/// The privileged helper's front door.
///
/// One client at a time, one connection at a time, and an allow-list of operations behind
/// it. Three things guard it, and each answers a different question:
///
/// 1. **The pipe ACL** answers "who may connect": SYSTEM and Administrators only. A standard
///    user cannot open the pipe at all, so nothing below is reachable from an ordinary
///    account.
/// 2. **Caller verification** answers "which program is connecting": the client's process id
///    is read from the pipe itself — not sent by the client, which could lie — and its image
///    path has to be the WOLF agent sitting beside this helper. Another SYSTEM process on the
///    machine cannot drive it.
/// 3. **The nonce and sequence** answer "is this request fresh": a nonce this helper
///    generated for this connection, and a strictly increasing sequence within it. A captured
///    request cannot be replayed, on this connection or a later one.
///
/// None of this stops an attacker who is already SYSTEM and can replace the agent binary.
/// It is not meant to. What it stops is everything short of that, and it keeps the privileged
/// surface to the operations named in <see cref="HelperProtocol.Operations"/>.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class HelperServer : IAsyncDisposable
{
    /// <summary>The agent executable allowed to drive this helper.</summary>
    private const string AgentExecutableName = "Wolf.Agent.exe";

    private readonly ILogger<HelperServer> _logger;
    private readonly ILoggerFactory _loggers;
    private readonly string _helperVersion;
    private readonly string? _expectedAgentPath;

    private CancellationTokenSource? _running;
    private Task? _loop;

    public HelperServer(ILoggerFactory loggers, string helperVersion, string? expectedAgentPath = null)
    {
        _loggers = loggers;
        _logger = loggers.CreateLogger<HelperServer>();
        _helperVersion = helperVersion;

        // The agent is installed beside the helper. Resolved once, at startup, so a later
        // change to the directory cannot redirect what this helper will talk to.
        _expectedAgentPath = expectedAgentPath ??
            Path.Combine(AppContext.BaseDirectory, AgentExecutableName);
    }

    /// <summary>Requests served since the helper started. Read by the tests and the logs.</summary>
    public long RequestsServed { get; private set; }

    public void Start()
    {
        if (_loop is not null) return;
        _running = new CancellationTokenSource();
        _loop = Task.Run(() => ServeAsync(_running.Token));
    }

    private async Task ServeAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                await ServeOneConnectionAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                // A helper that stops listening is a PC that has silently lost every
                // privileged operation, so nothing gets to end this loop except shutdown.
                _logger.LogError(ex, "A helper connection failed; still listening.");

                try
                {
                    await Task.Delay(TimeSpan.FromSeconds(1), cancellationToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    return;
                }
            }
        }
    }

    private async Task ServeOneConnectionAsync(CancellationToken cancellationToken)
    {
        using NamedPipeServerStream pipe = CreatePipe();

        await pipe.WaitForConnectionAsync(cancellationToken).ConfigureAwait(false);

        if (!VerifyCaller(pipe))
        {
            // Disconnected without a word. A caller that failed this check is not a WOLF
            // component, and telling it why would only help somebody probing.
            pipe.Disconnect();
            return;
        }

        var channel = new IpcChannel(pipe);

        // The nonce is generated here and never leaves this connection. It is what makes a
        // captured request useless: replaying it needs a nonce this helper has forgotten.
        string nonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(16));
        var guard = new HelperRequestGuard(nonce);

        await channel.SendAsync(
            new HelperHelloMessage(HelperHelloMessage.KindName, HelperProtocol.Version, _helperVersion, nonce),
            cancellationToken).ConfigureAwait(false);

        await foreach (JsonDocument document in channel.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            using (document)
            {
                HelperResponseMessage response = Handle(document.RootElement, guard);
                RequestsServed++;
                await channel.SendAsync(response, cancellationToken).ConfigureAwait(false);
            }
        }
    }

    /// <summary>
    /// Check one request and perform it, or say why not.
    ///
    /// Every refusal carries a distinct code so the agent's log says which check failed
    /// rather than "the helper said no". The checking itself lives in
    /// <see cref="HelperRequestGuard"/>, which has no I/O and can therefore be tested
    /// without opening a pipe only SYSTEM and Administrators can open.
    /// </summary>
    private HelperResponseMessage Handle(JsonElement message, HelperRequestGuard guard)
    {
        long sequence = message.TryGetProperty("sequence", out JsonElement sequenceElement) &&
                        sequenceElement.TryGetInt64(out long parsed)
            ? parsed
            : 0;

        string operation = ReadString(message, "operation") ?? string.Empty;

        HelperRefusal? refusal = guard.Check(
            ReadString(message, "kind"),
            ReadInt(message, "version"),
            ReadString(message, "nonce"),
            sequence,
            operation);

        if (refusal is not null)
        {
            _logger.LogWarning(
                "Refused a helper request ({Code}) for operation {Operation}.",
                refusal.Code,
                operation);

            return Refused(sequence, refusal.Code, refusal.Message);
        }

        JsonElement payload = message.TryGetProperty("payload", out JsonElement value)
            ? value
            : default;

        try
        {
            return Perform(operation, payload, sequence);
        }
        catch (Exception ex) when (ex is System.Management.ManagementException
                                       or InvalidOperationException
                                       or UnauthorizedAccessException)
        {
            _logger.LogError(ex, "The operation {Operation} failed.", operation);
            return Refused(sequence, "failed", "The operation could not be completed on this PC.");
        }
    }

    private HelperResponseMessage Perform(string operation, JsonElement payload, long sequence)
    {
        switch (operation)
        {
            case HelperProtocol.Operations.Describe:
            {
                var description = new HelperDescription(
                    _helperVersion,
                    new[]
                    {
                        HelperProtocol.Operations.Describe,
                        HelperProtocol.Operations.DiskSmartHealth,
                        HelperProtocol.Operations.DeviceList,
                        HelperProtocol.Operations.DeviceSetEnabled,
                        HelperProtocol.Operations.ServiceList,
                        HelperProtocol.Operations.ServiceControl,
                        HelperProtocol.Operations.ServiceSetStartType,
                        HelperProtocol.Operations.TaskList,
                        HelperProtocol.Operations.TaskControl,
                        HelperProtocol.Operations.StartupList,
                        HelperProtocol.Operations.StartupSetEnabled,
                    },
                    WindowsIdentity.GetCurrent().Name);

                return Ok(sequence, description);
            }

            case HelperProtocol.Operations.DiskSmartHealth:
            {
                string? deviceId = payload.ValueKind == JsonValueKind.Object &&
                                   payload.TryGetProperty("deviceId", out JsonElement id) &&
                                   id.ValueKind == JsonValueKind.String
                    ? id.GetString()
                    : null;

                var reader = new SmartReader(_loggers.CreateLogger<SmartReader>());
                IReadOnlyList<HelperDiskHealth> disks = reader.Read(deviceId);

                _logger.LogInformation("Read health for {Count} drive(s).", disks.Count);
                return Ok(sequence, new HelperDiskHealthResult(disks));
            }

            case HelperProtocol.Operations.TaskList:
            {
                var manager = new TaskManager(_loggers.CreateLogger<TaskManager>());
                HelperTaskListResult result = manager.List(ReadPayloadString(payload, "search"));

                _logger.LogInformation("Listed {Count} scheduled task(s).", result.Tasks.Count);
                return Ok(sequence, result);
            }

            case HelperProtocol.Operations.TaskControl:
            {
                string? path = ReadPayloadString(payload, "path");
                string? action = ReadPayloadString(payload, "action");
                string? expected = ReadPayloadString(payload, "expectedName");

                if (path is null || action is null || expected is null)
                {
                    return Refused(
                        sequence,
                        "malformed",
                        "A task change needs a path, an action, and the name it was last seen under.");
                }

                var manager = new TaskManager(_loggers.CreateLogger<TaskManager>());
                return Ok(sequence, manager.Control(path, action, expected));
            }

            case HelperProtocol.Operations.StartupList:
            {
                var manager = new StartupManager(_loggers.CreateLogger<StartupManager>());
                HelperStartupListResult result = manager.List();

                _logger.LogInformation("Listed {Count} startup entr(ies).", result.Entries.Count);
                return Ok(sequence, result);
            }

            case HelperProtocol.Operations.StartupSetEnabled:
            {
                string? name = ReadPayloadString(payload, "name");
                string? scope = ReadPayloadString(payload, "scope");
                string? source = ReadPayloadString(payload, "source");

                if (name is null || scope is null || source is null)
                {
                    return Refused(
                        sequence,
                        "malformed",
                        "A startup change needs a name, a scope, and which of Windows' places it came from.");
                }

                bool enabled = payload.TryGetProperty("enabled", out JsonElement enabledElement) &&
                               enabledElement.ValueKind == JsonValueKind.True;

                var manager = new StartupManager(_loggers.CreateLogger<StartupManager>());
                return Ok(sequence, manager.SetEnabled(name, scope, source, enabled));
            }

            case HelperProtocol.Operations.ServiceList:
            {
                var manager = new ServiceManager(_loggers.CreateLogger<ServiceManager>());
                IReadOnlyList<HelperService> services = manager.List(ReadPayloadString(payload, "search"));

                _logger.LogInformation("Listed {Count} service(s).", services.Count);
                return Ok(sequence, new HelperServiceListResult(services));
            }

            case HelperProtocol.Operations.ServiceControl:
            {
                string? name = ReadPayloadString(payload, "name");
                string? action = ReadPayloadString(payload, "action");
                string? expected = ReadPayloadString(payload, "expectedDisplayName");

                if (name is null || action is null || expected is null)
                {
                    // The expected name is not optional, for the same reason a process id is
                    // checked against its name before it is terminated: a service list the
                    // operator read a minute ago can describe a machine that has changed.
                    return Refused(
                        sequence,
                        "malformed",
                        "A service change needs a name, an action, and the display name it was last seen under.");
                }

                var manager = new ServiceManager(_loggers.CreateLogger<ServiceManager>());
                HelperServiceResult result = manager.Control(name, action, expected);

                // Returned as a successful call whatever the outcome. "Windows refused" and
                // "the helper refused" are answers the operator needs in full, not errors
                // that lose the detail on the way back.
                return Ok(sequence, result);
            }

            case HelperProtocol.Operations.ServiceSetStartType:
            {
                string? name = ReadPayloadString(payload, "name");
                string? startType = ReadPayloadString(payload, "startType");
                string? expected = ReadPayloadString(payload, "expectedDisplayName");

                if (name is null || startType is null || expected is null)
                {
                    return Refused(
                        sequence,
                        "malformed",
                        "A start-type change needs a name, a start type, and the display name it was last seen under.");
                }

                var manager = new ServiceManager(_loggers.CreateLogger<ServiceManager>());
                return Ok(sequence, manager.SetStartType(name, startType, expected));
            }

            case HelperProtocol.Operations.DeviceList:
            {
                string? deviceClass = ReadPayloadString(payload, "deviceClass");
                bool includeAbsent = payload.ValueKind == JsonValueKind.Object &&
                                     payload.TryGetProperty("includeAbsent", out JsonElement absent) &&
                                     absent.ValueKind == JsonValueKind.True;

                var manager = new DeviceManager(_loggers.CreateLogger<DeviceManager>());
                IReadOnlyList<HelperDevice> devices = manager.List(deviceClass, includeAbsent);

                _logger.LogInformation("Listed {Count} device(s).", devices.Count);
                return Ok(sequence, new HelperDeviceListResult(devices));
            }

            case HelperProtocol.Operations.DeviceSetEnabled:
            {
                string? instanceId = ReadPayloadString(payload, "instanceId");
                string? expectedName = ReadPayloadString(payload, "expectedName");

                if (instanceId is null || expectedName is null)
                {
                    // The expected name is not optional. Changing a device without checking
                    // it is the one thing this operation is careful about, and a caller that
                    // omits it does not get the unchecked version.
                    return Refused(
                        sequence,
                        "malformed",
                        "A device change needs both an instance id and the name it was last seen under.");
                }

                bool enabled = payload.TryGetProperty("enabled", out JsonElement enabledElement) &&
                               enabledElement.ValueKind == JsonValueKind.True;

                var manager = new DeviceManager(_loggers.CreateLogger<DeviceManager>());
                HelperDeviceResult result = manager.SetEnabled(instanceId, enabled, expectedName);

                // Returned as a successful call whatever the outcome. "Windows refused" and
                // "the helper refused" are answers the operator needs in full, not errors
                // that lose the detail on the way back.
                return Ok(sequence, result);
            }

            default:
                // Unreachable: the allow-list above is checked first. Kept so adding a name
                // to the allow-list without adding its implementation fails loudly here
                // rather than returning a successful empty answer.
                return Refused(sequence, "not-implemented", $"'{operation}' is allowed but not implemented.");
        }
    }

    private static HelperResponseMessage Ok<T>(long sequence, T result) =>
        new(
            HelperResponseMessage.KindName,
            sequence,
            Ok: true,
            Code: null,
            Message: null,
            Result: JsonSerializer.SerializeToElement(result, WolfIpc.Json));

    private static HelperResponseMessage Refused(long sequence, string code, string message) =>
        new(HelperResponseMessage.KindName, sequence, Ok: false, Code: code, Message: message, Result: null);

    /// <summary>
    /// Confirm the process on the other end is the WOLF agent.
    ///
    /// The process id comes from the pipe, so it is Windows' answer rather than the client's
    /// claim. The image path is then compared against the agent beside this helper — which
    /// is why the helper resolves that path at startup rather than per connection.
    /// </summary>
    private bool VerifyCaller(NamedPipeServerStream pipe)
    {
        if (_expectedAgentPath is null) return true;

        if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(), out uint clientPid))
        {
            _logger.LogWarning("Could not identify the process connecting to the helper; refusing it.");
            return false;
        }

        string? callerPath = TryGetProcessPath((int)clientPid);
        if (callerPath is null)
        {
            _logger.LogWarning("Could not read the image path of process {Pid}; refusing it.", clientPid);
            return false;
        }

        if (!string.Equals(
                Path.GetFullPath(callerPath),
                Path.GetFullPath(_expectedAgentPath),
                StringComparison.OrdinalIgnoreCase))
        {
            _logger.LogWarning(
                "Refused a connection from {Path}; this helper only serves {Expected}.",
                callerPath,
                _expectedAgentPath);
            return false;
        }

        return true;
    }

    private static string? TryGetProcessPath(int pid)
    {
        try
        {
            using Process process = Process.GetProcessById(pid);
            return process.MainModule?.FileName;
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            return null;
        }
    }

    /// <summary>
    /// The pipe, locked to SYSTEM and Administrators.
    ///
    /// Inheritance is not a factor for a pipe, so this is the whole access list: no
    /// Authenticated Users, no Everyone, no interactive user. A standard account on this
    /// machine cannot open the helper at all, whatever it knows about the protocol.
    /// </summary>
    private static NamedPipeServerStream CreatePipe()
    {
        var security = new PipeSecurity();

        var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
        var administrators = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);

        foreach (SecurityIdentifier identity in new[] { system, administrators })
        {
            security.AddAccessRule(
                new PipeAccessRule(identity, PipeAccessRights.FullControl, AccessControlType.Allow));
        }

        return NamedPipeServerStreamAcl.Create(
            HelperProtocol.PipeName,
            PipeDirection.InOut,
            maxNumberOfServerInstances: 1,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous,
            inBufferSize: 0,
            outBufferSize: 0,
            security);
    }

    private static string? ReadPayloadString(JsonElement payload, string name) =>
        payload.ValueKind == JsonValueKind.Object &&
        payload.TryGetProperty(name, out JsonElement value) &&
        value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static string? ReadString(JsonElement element, string name) =>
        element.TryGetProperty(name, out JsonElement value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static int ReadInt(JsonElement element, string name) =>
        element.TryGetProperty(name, out JsonElement value) && value.TryGetInt32(out int parsed) ? parsed : 0;

    public async ValueTask DisposeAsync()
    {
        _running?.Cancel();

        if (_loop is not null)
        {
            try
            {
                await _loop.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
            }
        }

        _running?.Dispose();
        _running = null;
        _loop = null;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint clientProcessId);
}
