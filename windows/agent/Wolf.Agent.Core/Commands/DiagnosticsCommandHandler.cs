using System.Diagnostics.Eventing.Reader;
using System.Management;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.Versioning;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Wolf.Agent.Core.Diagnostics;
using Wolf.Agent.Core.Protocol;

namespace Wolf.Agent.Core.Commands;

/// <summary>
/// The three questions an operator asks when something is wrong and nothing has crashed: what
/// is the network doing, what has Windows been complaining about, and what is inside this
/// machine.
///
/// All three run in the agent rather than the privileged helper. None of them needs
/// administrator beyond what the agent already is, and the helper exists to keep a *narrow*
/// surface — adding four read operations to it that do not need its rights would widen it for
/// nothing.
///
/// Two of the three need something said about them plainly, and both are said where they
/// happen: <see cref="ProbePolicy"/> for why a network test is not a read, and
/// <see cref="QueryEventLog"/> for the one diagnostic whose content crosses the cloud.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class DiagnosticsCommandHandler : ICommandHandler
{
    /// <summary>Connections returned at once. A busy server has more; nobody reads more.</summary>
    private const int MaxConnections = 1000;

    /// <summary>Characters of one event message. Beyond this it is cut, and the answer says so.</summary>
    private const int MaxEventMessage = 4000;

    private readonly ILogger<DiagnosticsCommandHandler> _logger;

    public DiagnosticsCommandHandler(ILogger<DiagnosticsCommandHandler> logger)
    {
        _logger = logger;
    }

    public IReadOnlyList<string> SupportedTypes { get; } = new[]
    {
        "network.info",
        "network.test",
        "eventlog.query",
        "hardware.inventory",
    };

    public async Task<CommandExecution> ExecuteAsync(
        CommandEnvelope envelope,
        CancellationToken cancellationToken)
    {
        return envelope.Type switch
        {
            "network.info" => NetworkInfo(envelope.Payload),
            "network.test" => await NetworkTestAsync(envelope.Payload, cancellationToken).ConfigureAwait(false),
            "eventlog.query" => QueryEventLog(envelope.Payload),
            "hardware.inventory" => Inventory(envelope.Payload),
            _ => CommandExecution.Failed("unsupported", $"'{envelope.Type}' is not a diagnostic command."),
        };
    }

    /* --------------------------------------------------------------------- */
    /* Network configuration                                                  */
    /* --------------------------------------------------------------------- */

    private static CommandExecution NetworkInfo(JsonElement payload)
    {
        bool includeConnections = payload.TryGetProperty("includeConnections", out JsonElement element) &&
                                  element.ValueKind == JsonValueKind.True;

        var adapters = new List<object>();

        foreach (NetworkInterface adapter in NetworkInterface.GetAllNetworkInterfaces())
        {
            try
            {
                IPInterfaceProperties properties = adapter.GetIPProperties();

                adapters.Add(new
                {
                    id = adapter.Id,
                    name = adapter.Name,
                    description = adapter.Description,
                    kind = Kind(adapter.NetworkInterfaceType),
                    status = adapter.OperationalStatus.ToString().ToLowerInvariant(),
                    macAddress = Mac(adapter),
                    speedBitsPerSecond = adapter.Speed > 0 ? adapter.Speed : (long?)null,
                    addresses = properties.UnicastAddresses
                        .Select(entry => entry.Address.ToString())
                        .Take(16)
                        .ToArray(),
                    gateways = properties.GatewayAddresses
                        .Select(entry => entry.Address.ToString())
                        .Take(8)
                        .ToArray(),
                    dnsServers = properties.DnsAddresses.Select(entry => entry.ToString()).Take(8).ToArray(),
                    dhcpEnabled = Dhcp(properties),
                });
            }
            catch (NetworkInformationException)
            {
                // An adapter that went away mid-enumeration, or one whose properties Windows
                // will not report. Skipped rather than failing the whole answer for one row.
            }
        }

        var connections = new List<object>();
        bool truncated = false;

        if (includeConnections)
        {
            IPGlobalProperties global = IPGlobalProperties.GetIPGlobalProperties();

            foreach (TcpConnectionInformation connection in global.GetActiveTcpConnections())
            {
                if (connections.Count >= MaxConnections)
                {
                    truncated = true;
                    break;
                }

                connections.Add(new
                {
                    protocol = "tcp",
                    localEndpoint = connection.LocalEndPoint.ToString(),
                    remoteEndpoint = connection.RemoteEndPoint.ToString(),
                    state = connection.State.ToString().ToLowerInvariant(),
                });
            }

            foreach (IPEndPoint listener in global.GetActiveTcpListeners())
            {
                if (connections.Count >= MaxConnections)
                {
                    truncated = true;
                    break;
                }

                connections.Add(new
                {
                    protocol = "tcp",
                    localEndpoint = listener.ToString(),
                    remoteEndpoint = (string?)null,
                    state = "listen",
                });
            }

            // UDP has no state to report, only a socket that exists. Listed anyway, because
            // "what is this machine listening on" is the question, and half an answer to it
            // would be worse than none.
            foreach (IPEndPoint listener in global.GetActiveUdpListeners())
            {
                if (connections.Count >= MaxConnections)
                {
                    truncated = true;
                    break;
                }

                connections.Add(new
                {
                    protocol = "udp",
                    localEndpoint = listener.ToString(),
                    remoteEndpoint = (string?)null,
                    state = (string?)null,
                });
            }
        }

        IPGlobalProperties names = IPGlobalProperties.GetIPGlobalProperties();

        return CommandExecution.Success(new
        {
            hostName = names.HostName,
            domain = string.IsNullOrWhiteSpace(names.DomainName) ? null : names.DomainName,
            adapters,
            connections,
            connectionsTruncated = truncated,
            at = DateTimeOffset.UtcNow.ToString("o"),
        });
    }

    private static string Kind(NetworkInterfaceType type) => type switch
    {
        NetworkInterfaceType.Ethernet or NetworkInterfaceType.GigabitEthernet
            or NetworkInterfaceType.FastEthernetT or NetworkInterfaceType.FastEthernetFx => "ethernet",
        NetworkInterfaceType.Wireless80211 => "wifi",
        NetworkInterfaceType.Loopback => "loopback",
        NetworkInterfaceType.Tunnel or NetworkInterfaceType.Ppp => "tunnel",
        _ => "other",
    };

    private static string? Mac(NetworkInterface adapter)
    {
        byte[] bytes = adapter.GetPhysicalAddress().GetAddressBytes();
        return bytes.Length == 0 ? null : string.Join(':', bytes.Select(b => b.ToString("X2")));
    }

    private static bool? Dhcp(IPInterfaceProperties properties)
    {
        try
        {
            return properties.GetIPv4Properties()?.IsDhcpEnabled;
        }
        catch (Exception ex) when (ex is NetworkInformationException or PlatformNotSupportedException)
        {
            // An adapter with no IPv4 at all. Null rather than false: "not configured for
            // IPv4" and "configured with a static address" are different answers.
            return null;
        }
    }

    /* --------------------------------------------------------------------- */
    /* Network tests                                                          */
    /* --------------------------------------------------------------------- */

    private async Task<CommandExecution> NetworkTestAsync(JsonElement payload, CancellationToken cancellationToken)
    {
        string test = ReadString(payload, "test") ?? string.Empty;
        string? target = ReadString(payload, "target");

        ProbeVerdict verdict = ProbePolicy.Check(
            test,
            target,
            ReadInt(payload, "count", 4),
            ReadInt(payload, "timeoutMs", 2000),
            ReadInt(payload, "port", 0));

        if (!verdict.Ok)
        {
            return CommandExecution.Failed("probe-refused", verdict.Reason);
        }

        string host = target!.Trim();

        // Logged with the target, every time. The bounds stop a sweep; the trail is what
        // catches somebody assembling one out of many commands, and it is the reason a
        // network test is audited as an action rather than as a read.
        _logger.LogInformation("Network {Test} against {Target}.", test, host);

        return test switch
        {
            "dns" => await ResolveAsync(host, cancellationToken).ConfigureAwait(false),
            "ping" => await PingAsync(host, verdict, cancellationToken).ConfigureAwait(false),
            "tcp" => await ConnectAsync(host, verdict, cancellationToken).ConfigureAwait(false),
            _ => CommandExecution.Failed("probe-refused", $"'{test}' is not a network test WOLF runs."),
        };
    }

    private static async Task<CommandExecution> ResolveAsync(string host, CancellationToken cancellationToken)
    {
        try
        {
            IPAddress[] addresses = await Dns.GetHostAddressesAsync(host, cancellationToken).ConfigureAwait(false);

            return Answer("dns", host, addresses.Length > 0,
                addresses.Select(a => a.ToString()).Take(8).ToArray(),
                Array.Empty<double?>(),
                addresses.Length > 0 ? null : "The name resolved to nothing.");
        }
        catch (SocketException ex)
        {
            // A name that does not resolve is an answer, not a failure. The command ran
            // correctly and told the operator what they asked.
            return Answer("dns", host, false, Array.Empty<string>(), Array.Empty<double?>(),
                $"That name could not be resolved from this PC ({ex.SocketErrorCode}).");
        }
    }

    private static async Task<CommandExecution> PingAsync(string host, ProbeVerdict verdict, CancellationToken cancellationToken)
    {
        var times = new List<double?>();
        var resolved = new List<string>();
        string? detail = null;
        bool reachable = false;

        using var ping = new Ping();

        for (int attempt = 0; attempt < verdict.Count && !cancellationToken.IsCancellationRequested; attempt++)
        {
            try
            {
                PingReply reply = await ping.SendPingAsync(host, verdict.TimeoutMs).ConfigureAwait(false);

                if (reply.Address is not null && resolved.Count == 0)
                {
                    // Checked after resolution, because a name is not a shape: a host name
                    // that resolves to a multicast group is the case the syntactic check
                    // cannot catch, and it is the one that matters.
                    if (!ProbePolicy.IsProbeableAddress(reply.Address))
                    {
                        return CommandExecution.Failed(
                            "probe-refused",
                            "That name resolves to a broadcast or multicast address, which WOLF will not probe.");
                    }

                    resolved.Add(reply.Address.ToString());
                }

                if (reply.Status == IPStatus.Success)
                {
                    reachable = true;
                    times.Add(reply.RoundtripTime);
                }
                else
                {
                    times.Add(null);
                    detail ??= $"Windows reported {reply.Status}.";
                }
            }
            catch (Exception ex) when (ex is PingException or SocketException)
            {
                times.Add(null);
                detail ??= "That host could not be reached from this PC.";
            }
        }

        return Answer("ping", host, reachable, resolved, times, detail);
    }

    private static async Task<CommandExecution> ConnectAsync(string host, ProbeVerdict verdict, CancellationToken cancellationToken)
    {
        var stopwatch = System.Diagnostics.Stopwatch.StartNew();

        try
        {
            using var client = new TcpClient();
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(verdict.TimeoutMs);

            await client.ConnectAsync(host, verdict.Port, timeout.Token).ConfigureAwait(false);

            return Answer("tcp", host, true,
                new[] { client.Client.RemoteEndPoint?.ToString() ?? host },
                new double?[] { stopwatch.Elapsed.TotalMilliseconds },
                $"Port {verdict.Port} accepted a connection.");
        }
        catch (OperationCanceledException)
        {
            // The distinction that matters: a port that is filtered times out, a port that is
            // closed refuses. An operator diagnosing a firewall needs to know which.
            return Answer("tcp", host, false, Array.Empty<string>(), new double?[] { null },
                $"Port {verdict.Port} did not answer within {verdict.TimeoutMs} ms — filtered, or nothing is there.");
        }
        catch (SocketException ex)
        {
            return Answer("tcp", host, false, Array.Empty<string>(), new double?[] { null },
                ex.SocketErrorCode == SocketError.ConnectionRefused
                    ? $"Port {verdict.Port} refused the connection, so something answered and said no."
                    : $"The connection failed ({ex.SocketErrorCode}).");
        }
    }

    private static CommandExecution Answer(
        string test,
        string target,
        bool reachable,
        IReadOnlyList<string> resolved,
        IReadOnlyList<double?> times,
        string? detail) =>
        CommandExecution.Success(new
        {
            test,
            target,
            reachable,
            resolved,
            roundTripMs = times,
            detail,
            at = DateTimeOffset.UtcNow.ToString("o"),
        });

    /* --------------------------------------------------------------------- */
    /* Event log                                                              */
    /* --------------------------------------------------------------------- */

    /// <summary>
    /// Read Windows event log entries.
    ///
    /// **This is the one diagnostic read whose content crosses the cloud**, and it is worth
    /// naming rather than discovering. An event message can carry an account name, a command
    /// line, a file path, or — from software that should know better — a credential. It
    /// travels with the command result and is retained with it.
    ///
    /// It is on the command path anyway, because the value of an event log is in reading it
    /// beside everything else WOLF knows about the machine, and because these entries are
    /// already a record the machine keeps on disk. What is bounded is how much of it moves: a
    /// count, a window, a level, and a cap on each message.
    /// </summary>
    private CommandExecution QueryEventLog(JsonElement payload)
    {
        string log = ReadString(payload, "log") ?? "System";
        string minimum = ReadString(payload, "minimumLevel") ?? "warning";
        int hours = Math.Clamp(ReadInt(payload, "withinHours", 24), 1, 168);
        int limit = Math.Clamp(ReadInt(payload, "limit", 100), 1, 200);
        string? provider = ReadString(payload, "provider");
        int eventId = ReadInt(payload, "eventId", 0);

        if (log is not ("System" or "Application" or "Security" or "Setup"))
        {
            return CommandExecution.Failed("invalid-payload", $"'{log}' is not a log WOLF reads.");
        }

        string query = BuildQuery(minimum, hours, provider, eventId);
        var events = new List<object>();
        bool truncated = false;

        try
        {
            var reader = new EventLogQuery(log, PathType.LogName, query) { ReverseDirection = true };
            using var stream = new EventLogReader(reader);

            for (EventRecord? record = stream.ReadEvent(); record is not null; record = stream.ReadEvent())
            {
                using (record)
                {
                    if (events.Count >= limit)
                    {
                        truncated = true;
                        break;
                    }

                    events.Add(Describe(record, log));
                }
            }
        }
        catch (UnauthorizedAccessException)
        {
            // The Security log without administrator. Reported as an empty answer with a
            // reason rather than a failure: nothing is broken, and "WOLF may not read this"
            // is what the operator needs to know.
            return CommandExecution.Success(new
            {
                log,
                events = Array.Empty<object>(),
                truncated = false,
                unavailableReason = $"WOLF is not allowed to read the {log} log on this PC.",
                at = DateTimeOffset.UtcNow.ToString("o"),
            });
        }
        catch (EventLogException ex)
        {
            _logger.LogWarning("The {Log} log could not be read: {Message}", log, ex.Message);

            return CommandExecution.Failed(
                "eventlog-failed",
                $"The {log} log could not be read on this PC.",
                "Check that the Windows Event Log service is running.");
        }

        _logger.LogInformation("Read {Count} event(s) from the {Log} log.", events.Count, log);

        return CommandExecution.Success(new
        {
            log,
            events,
            truncated,
            unavailableReason = (string?)null,
            at = DateTimeOffset.UtcNow.ToString("o"),
        });
    }

    /// <summary>
    /// Build the XPath the event log reader takes.
    ///
    /// Every value is either a number this method produced or a name checked against a fixed
    /// list — nothing from the payload reaches the query as text except the provider, which is
    /// quote-escaped. An XPath built by concatenating operator input would be an injection
    /// surface into a component running as SYSTEM.
    /// </summary>
    private static string BuildQuery(string minimum, int hours, string? provider, int eventId)
    {
        // Windows' levels are 1 critical, 2 error, 3 warning, 4 information, 5 verbose — and
        // 0, which providers use for "no level given" and which is almost always something
        // worth seeing. Included at every threshold rather than hidden.
        int level = minimum switch
        {
            "critical" => 1,
            "error" => 2,
            "warning" => 3,
            "information" => 4,
            _ => 5,
        };

        var clauses = new List<string>
        {
            $"(Level <= {level} or Level = 0)",
            $"TimeCreated[timediff(@SystemTime) <= {(long)TimeSpan.FromHours(hours).TotalMilliseconds}]",
        };

        if (eventId > 0) clauses.Add($"EventID = {eventId}");

        if (!string.IsNullOrWhiteSpace(provider))
        {
            // Doubling a single quote is how XPath escapes one. A provider name containing
            // one is not a thing that exists, and this is here so that it staying not-a-thing
            // is not load-bearing.
            string safe = provider.Replace("'", "''", StringComparison.Ordinal);
            clauses.Add($"Provider[@Name='{safe}']");
        }

        return $"*[System[{string.Join(" and ", clauses)}]]";
    }

    private static object Describe(EventRecord record, string log)
    {
        string? message = null;

        try
        {
            message = record.FormatDescription();
        }
        catch (EventLogException)
        {
            // A provider whose message DLL is missing — an uninstalled application is the
            // usual cause. The event id and provider are still the useful part.
        }

        bool cut = message is { Length: > MaxEventMessage };
        if (cut) message = message![..MaxEventMessage];

        return new
        {
            recordId = record.RecordId,
            log,
            provider = record.ProviderName,
            eventId = record.Id,
            level = LevelName(record.Level),
            createdAt = record.TimeCreated?.ToUniversalTime().ToString("o"),
            machine = record.MachineName,
            message,
            messageTruncated = cut,
        };
    }

    private static string LevelName(byte? level) => level switch
    {
        1 => "critical",
        2 => "error",
        3 => "warning",
        4 => "information",
        5 => "verbose",
        _ => "information",
    };

    /* --------------------------------------------------------------------- */
    /* Hardware                                                               */
    /* --------------------------------------------------------------------- */

    private CommandExecution Inventory(JsonElement payload)
    {
        bool serials = payload.TryGetProperty("includeSerialNumbers", out JsonElement element) &&
                       element.ValueKind == JsonValueKind.True;

        string? manufacturer = null, model = null, serial = null;
        string? biosVendor = null, biosVersion = null, biosReleased = null, baseboard = null;
        object? cpu = null;
        var memory = new List<object>();
        var disks = new List<object>();
        var gpus = new List<object>();
        var monitors = new List<object>();

        Query("Win32_ComputerSystem", row =>
        {
            manufacturer ??= Text(row, "Manufacturer");
            model ??= Text(row, "Model");
        });

        Query("Win32_ComputerSystemProduct", row => serial ??= serials ? Text(row, "IdentifyingNumber") : null);

        Query("Win32_BIOS", row =>
        {
            biosVendor ??= Text(row, "Manufacturer");
            biosVersion ??= Text(row, "SMBIOSBIOSVersion");
            biosReleased ??= Date(row, "ReleaseDate");
        });

        Query("Win32_BaseBoard", row =>
            baseboard ??= Join(Text(row, "Manufacturer"), Text(row, "Product")));

        Query("Win32_Processor", row => cpu ??= new
        {
            name = Text(row, "Name"),
            cores = Number(row, "NumberOfCores"),
            threads = Number(row, "NumberOfLogicalProcessors"),
            maxClockMhz = Number(row, "MaxClockSpeed"),
            socket = Text(row, "SocketDesignation"),
        });

        Query("Win32_PhysicalMemory", row =>
        {
            if (memory.Count >= 32) return;

            memory.Add(new
            {
                slot = Text(row, "DeviceLocator"),
                capacityBytes = Large(row, "Capacity"),
                speedMhz = Number(row, "Speed"),
                manufacturer = Text(row, "Manufacturer"),
                partNumber = Text(row, "PartNumber")?.Trim(),
                serialNumber = serials ? Text(row, "SerialNumber")?.Trim() : null,
            });
        });

        Query("Win32_DiskDrive", row =>
        {
            if (disks.Count >= 32) return;

            disks.Add(new
            {
                model = Text(row, "Model"),
                sizeBytes = Large(row, "Size"),
                busType = Text(row, "InterfaceType"),
                mediaType = Text(row, "MediaType"),
                serialNumber = serials ? Text(row, "SerialNumber")?.Trim() : null,
            });
        });

        Query("Win32_VideoController", row =>
        {
            if (gpus.Count >= 8) return;

            string? name = Text(row, "Name");
            if (name is null) return;

            gpus.Add(new
            {
                name,
                driverVersion = Text(row, "DriverVersion"),
                // AdapterRAM is a 32-bit field and wraps above 4 GB, so a card with more
                // reports a number that is wrong rather than large. Reported as unknown
                // instead of confidently incorrect.
                memoryBytes = Large(row, "AdapterRAM") is { } bytes and < 4_294_967_295 ? bytes : (long?)null,
            });
        });

        Query("Win32_DesktopMonitor", row =>
        {
            if (monitors.Count >= 16) return;

            monitors.Add(new
            {
                name = Text(row, "Name"),
                widthPixels = Number(row, "ScreenWidth"),
                heightPixels = Number(row, "ScreenHeight"),
            });
        });

        _logger.LogInformation(
            "Read the hardware inventory: {Memory} memory module(s), {Disks} disk(s), {Gpus} GPU(s).",
            memory.Count,
            disks.Count,
            gpus.Count);

        return CommandExecution.Success(new
        {
            manufacturer,
            model,
            serialNumber = serial,
            biosVendor,
            biosVersion,
            biosReleasedAt = biosReleased,
            baseboard,
            cpu,
            memoryModules = memory,
            disks,
            gpus,
            monitors,
            // So a blank field is read as "not asked for" rather than "not there".
            serialNumbersIncluded = serials,
            at = DateTimeOffset.UtcNow.ToString("o"),
        });
    }

    /// <summary>
    /// Run one WMI query, and carry on if it fails.
    ///
    /// A machine missing a class — a virtual machine with no `Win32_PhysicalMemory`, a server
    /// with no `Win32_DesktopMonitor` — is ordinary. An inventory that failed whole because
    /// one part of it was absent would be useless on exactly the machines somebody is asking
    /// about.
    /// </summary>
    private void Query(string className, Action<ManagementBaseObject> row)
    {
        try
        {
            using var searcher = new ManagementObjectSearcher($"SELECT * FROM {className}");
            using ManagementObjectCollection results = searcher.Get();

            foreach (ManagementBaseObject item in results)
            {
                using (item) row(item);
            }
        }
        catch (Exception ex) when (ex is ManagementException
                                       or UnauthorizedAccessException
                                       or System.Runtime.InteropServices.COMException)
        {
            _logger.LogDebug(ex, "{Class} could not be read on this PC.", className);
        }
    }

    private static string? Text(ManagementBaseObject row, string name)
    {
        try
        {
            string? value = row[name]?.ToString();
            return string.IsNullOrWhiteSpace(value) ? null : value;
        }
        catch (ManagementException)
        {
            return null;
        }
    }

    private static int? Number(ManagementBaseObject row, string name) =>
        int.TryParse(Text(row, name), out int value) ? value : null;

    private static long? Large(ManagementBaseObject row, string name) =>
        long.TryParse(Text(row, name), out long value) ? value : null;

    /// <summary>WMI dates are `yyyyMMddHHmmss.ffffff±UUU`, which nothing else reads.</summary>
    private static string? Date(ManagementBaseObject row, string name)
    {
        string? raw = Text(row, name);
        if (raw is null || raw.Length < 8) return null;

        return DateTime.TryParseExact(
            raw[..8],
            "yyyyMMdd",
            System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal,
            out DateTime parsed)
            ? parsed.ToString("o")
            : null;
    }

    private static string? Join(string? left, string? right) =>
        string.IsNullOrWhiteSpace(left)
            ? right
            : string.IsNullOrWhiteSpace(right)
                ? left
                : $"{left} {right}";

    private static string? ReadString(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object &&
        element.TryGetProperty(name, out JsonElement value) &&
        value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static int ReadInt(JsonElement element, string name, int fallback) =>
        element.ValueKind == JsonValueKind.Object &&
        element.TryGetProperty(name, out JsonElement value) &&
        value.ValueKind == JsonValueKind.Number &&
        value.TryGetInt32(out int parsed)
            ? parsed
            : fallback;
}
