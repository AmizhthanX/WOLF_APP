using System.Net;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Wolf.Agent.Core.Commands;
using Wolf.Agent.Core.Diagnostics;
using Wolf.Agent.Core.Protocol;
using Xunit;
using Xunit.Abstractions;

namespace Wolf.Agent.Core.Tests;

/// <summary>
/// The three questions an operator asks when something is wrong and nothing has crashed.
///
/// Two of them are ordinary reads and are tested against this machine for real: a network
/// configuration and a hardware inventory are enumerations of somewhere messy, and a mock
/// would prove the code walks a machine somebody invented.
///
/// The third is not a read at all. A network test asks somebody else's PC to send packets to a
/// destination the operator chose, and most of what is below is about the bounds on that —
/// because the difference between a diagnostic tool and a scanner is entirely in the bounds
/// and the audit trail, not in the intent of whoever typed the command.
/// </summary>
public sealed class DiagnosticsTests
{
    private readonly ITestOutputHelper _output;

    public DiagnosticsTests(ITestOutputHelper output)
    {
        _output = output;
    }

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private static DiagnosticsCommandHandler Handler() =>
        new(NullLogger<DiagnosticsCommandHandler>.Instance);

    private static async Task<CommandExecution> RunAsync(string type, object payload) =>
        await Handler().ExecuteAsync(
            new CommandEnvelope(
                CommandId: "01J9ZQK7T0000000000000000C",
                PcId: "01J9ZQK7T0000000000000000P",
                RequestId: "01J9ZQK7T0000000000000000Q",
                IssuedAt: DateTimeOffset.UtcNow,
                ExpiresAt: DateTimeOffset.UtcNow.AddMinutes(1),
                IdempotencyKey: "01J9ZQK7T0000000000000000I",
                Type: type,
                Payload: JsonSerializer.SerializeToElement(payload, Json),
                Authorization: default),
            CancellationToken.None);

    private static JsonElement Result(CommandExecution execution) =>
        JsonSerializer.SerializeToElement(execution.Result, Json);

    /// <summary>A command that produced a result rather than a failure.</summary>
    private static void Succeeded(CommandExecution execution)
    {
        Assert.True(
            execution.Failure is null,
            execution.Failure is null ? string.Empty : $"{execution.Failure.Code}: {execution.Failure.Message}");
        Assert.NotNull(execution.Result);
    }

    /* --------------------------------------------------------------------- */
    /* What WOLF will and will not probe                                      */
    /* --------------------------------------------------------------------- */

    [Theory]
    [InlineData("192.168.1.1", "an ordinary private address")]
    [InlineData("8.8.8.8", "an ordinary public address")]
    [InlineData("fileserver.corp.example", "a host name")]
    [InlineData("127.0.0.1", "loopback, which answers 'is the stack working at all'")]
    [InlineData("2606:4700:4700::1111", "an IPv6 address")]
    public void An_ordinary_host_is_probeable(string target, string what)
    {
        ProbeVerdict verdict = ProbePolicy.Check("ping", target, 4, 2000, 0);

        _output.WriteLine($"{what}: {(verdict.Ok ? "allowed" : verdict.Reason)}");

        // WOLF does not try to tell a legitimate target from an illegitimate one, because it
        // cannot: "can this PC reach the file server" and "can this PC reach the internet" are
        // the two most common diagnostics there are, and a rule blocking private or public
        // ranges would break one of them.
        Assert.True(verdict.Ok, verdict.Reason);
    }

    [Theory]
    [InlineData("192.168.1.0/24", "a CIDR range")]
    [InlineData("10.0.0.1,10.0.0.2", "a list")]
    [InlineData("10.0.0.1 10.0.0.2", "a space-separated list")]
    public void Anything_that_expands_into_many_hosts_is_refused(string target, string what)
    {
        ProbeVerdict verdict = ProbePolicy.Check("ping", target, 4, 2000, 0);

        _output.WriteLine($"{what}: {verdict.Reason}");

        // One command must stay one probe. These are refused rather than treated as literal
        // host names that then fail to resolve for a reason nobody can read.
        Assert.False(verdict.Ok);
        Assert.Contains("one host", verdict.Reason, StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData("255.255.255.255", "the all-ones broadcast")]
    [InlineData("192.168.1.255", "an ordinary /24's broadcast address")]
    [InlineData("224.0.0.1", "the all-hosts multicast group")]
    [InlineData("239.255.255.250", "SSDP's multicast group")]
    [InlineData("ff02::1", "IPv6 all-nodes multicast")]
    public void An_address_that_reaches_a_whole_segment_is_refused(string target, string what)
    {
        ProbeVerdict verdict = ProbePolicy.Check("ping", target, 4, 2000, 0);

        _output.WriteLine($"{what}: {verdict.Reason}");

        // The one thing refused outright. One packet to either reaches every listener on the
        // segment, which is a sweep whatever it was meant to be.
        Assert.False(verdict.Ok);
    }

    [Fact]
    public void A_name_that_resolves_to_multicast_is_caught_after_resolution()
    {
        // A name is not a shape, so the syntactic check cannot catch this — and it is exactly
        // the case that would get past a check that only looked at the string.
        Assert.True(ProbePolicy.Check("ping", "all-hosts.example", 4, 2000, 0).Ok);
        Assert.False(ProbePolicy.IsProbeableAddress(IPAddress.Parse("224.0.0.1")));
        Assert.True(ProbePolicy.IsProbeableAddress(IPAddress.Parse("192.168.1.10")));
    }

    [Fact]
    public void A_count_above_the_cap_is_clamped_rather_than_refused()
    {
        ProbeVerdict verdict = ProbePolicy.Check("ping", "192.168.1.1", 500, 60_000, 0);

        _output.WriteLine($"count={verdict.Count} timeout={verdict.TimeoutMs}");

        // A client asking for five hundred pings is not attacking anything — it is a client
        // that has not read the protocol — and giving it four is more useful than an error.
        Assert.True(verdict.Ok);
        Assert.Equal(ProbePolicy.MaxCount, verdict.Count);
        Assert.Equal(ProbePolicy.MaxTimeoutMs, verdict.TimeoutMs);
    }

    [Fact]
    public void A_tcp_test_takes_one_port_and_never_a_range()
    {
        Assert.True(ProbePolicy.Check("tcp", "192.168.1.1", 1, 2000, 445).Ok);

        // A port range is a port scan with a different name. There is no field for one, and
        // an out-of-range port is refused rather than clamped into scanning something else.
        Assert.False(ProbePolicy.Check("tcp", "192.168.1.1", 1, 2000, 0).Ok);
        Assert.False(ProbePolicy.Check("tcp", "192.168.1.1", 1, 2000, 70_000).Ok);

        // And a TCP test is one connection however many were asked for.
        Assert.Equal(1, ProbePolicy.Check("tcp", "192.168.1.1", 99, 2000, 445).Count);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("traceroute")]
    public void A_test_WOLF_does_not_run_is_refused(string test)
    {
        Assert.False(ProbePolicy.Check(test, "192.168.1.1", 1, 2000, 0).Ok);
    }

    [Fact]
    public void A_probe_with_no_target_is_refused_rather_than_defaulted()
    {
        // The direction a bug here should fail. An empty target reaching a socket is at best
        // an error and at worst somebody else's machine.
        Assert.False(ProbePolicy.Check("ping", null, 4, 2000, 0).Ok);
        Assert.False(ProbePolicy.Check("ping", "", 4, 2000, 0).Ok);
        Assert.False(ProbePolicy.Check("ping", "   ", 4, 2000, 0).Ok);
    }

    /* --------------------------------------------------------------------- */
    /* Against this machine                                                   */
    /* --------------------------------------------------------------------- */

    [Fact]
    public async Task The_network_configuration_reads_back_from_the_real_machine()
    {
        CommandExecution execution = await RunAsync("network.info", new { includeConnections = false });

        Succeeded(execution);

        JsonElement result = Result(execution);
        JsonElement adapters = result.GetProperty("adapters");

        _output.WriteLine($"host={result.GetProperty("hostName").GetString()} adapters={adapters.GetArrayLength()}");

        foreach (JsonElement adapter in adapters.EnumerateArray().Take(4))
        {
            _output.WriteLine(
                $"  {adapter.GetProperty("name").GetString()} " +
                $"[{adapter.GetProperty("kind").GetString()}/{adapter.GetProperty("status").GetString()}] " +
                $"{adapter.GetProperty("addresses").GetArrayLength()} address(es)");
        }

        // Every machine has at least a loopback adapter. None at all would mean the
        // enumeration is wrong rather than the machine being unusual.
        Assert.True(adapters.GetArrayLength() > 0);
        Assert.False(string.IsNullOrWhiteSpace(result.GetProperty("hostName").GetString()));

        // Connections are the expensive half and are off unless asked for.
        Assert.Equal(0, result.GetProperty("connections").GetArrayLength());
    }

    [Fact]
    public async Task Asking_for_connections_returns_what_the_machine_has_open()
    {
        CommandExecution execution = await RunAsync("network.info", new { includeConnections = true });
        JsonElement result = Result(execution);

        JsonElement connections = result.GetProperty("connections");
        _output.WriteLine($"{connections.GetArrayLength()} connection(s) and listener(s)");

        // A machine running a test suite has sockets open. Every row says which protocol and
        // which end, because "this machine is listening on 445" and "this machine is talking
        // to 10.0.0.5" are different findings.
        Assert.True(connections.GetArrayLength() > 0);
        Assert.All(
            connections.EnumerateArray().Take(20).ToArray(),
            connection =>
            {
                Assert.Contains(connection.GetProperty("protocol").GetString(), new[] { "tcp", "udp" });
                Assert.False(string.IsNullOrWhiteSpace(connection.GetProperty("localEndpoint").GetString()));
            });
    }

    [Fact]
    public async Task Loopback_answers_a_ping_and_the_round_trip_is_reported()
    {
        CommandExecution execution = await RunAsync(
            "network.test",
            new { test = "ping", target = "127.0.0.1", count = 2, timeoutMs = 1000 });

        Succeeded(execution);

        JsonElement result = Result(execution);
        _output.WriteLine(result.ToString());

        // A real ICMP echo against the local stack. If this does not answer, nothing else
        // about the network path is worth testing.
        Assert.True(result.GetProperty("reachable").GetBoolean());
        Assert.Equal(2, result.GetProperty("roundTripMs").GetArrayLength());
    }

    [Fact]
    public async Task A_name_that_does_not_exist_is_an_answer_rather_than_a_failure()
    {
        CommandExecution execution = await RunAsync(
            "network.test",
            new { test = "dns", target = $"wolf-no-such-host-{Guid.NewGuid():N}.invalid" });

        JsonElement result = Result(execution);
        _output.WriteLine(result.ToString());

        // The command ran correctly and told the operator what they asked. Reporting it as a
        // failure would conflate "WOLF could not ask" with "the machine could not resolve it",
        // which are different problems with different next steps.
        Succeeded(execution);
        Assert.False(result.GetProperty("reachable").GetBoolean());
        Assert.Equal(0, result.GetProperty("resolved").GetArrayLength());
    }

    [Fact]
    public async Task A_refused_probe_never_reaches_a_socket()
    {
        CommandExecution execution = await RunAsync(
            "network.test",
            new { test = "ping", target = "224.0.0.1", count = 4 });

        _output.WriteLine($"{execution.Failure?.Code}: {execution.Failure?.Message}");

        Assert.NotNull(execution.Failure);
        Assert.Equal("probe-refused", execution.Failure!.Code);
    }

    [Fact]
    public async Task The_event_log_reads_back_real_entries()
    {
        CommandExecution execution = await RunAsync(
            "eventlog.query",
            new { log = "System", minimumLevel = "warning", withinHours = 168, limit = 20 });

        Succeeded(execution);

        JsonElement result = Result(execution);
        JsonElement events = result.GetProperty("events");

        _output.WriteLine($"{events.GetArrayLength()} event(s) in the last week");

        foreach (JsonElement entry in events.EnumerateArray().Take(3))
        {
            _output.WriteLine(
                $"  [{entry.GetProperty("level").GetString()}] " +
                $"{entry.GetProperty("provider").GetString()} " +
                $"#{entry.GetProperty("eventId").GetInt32()} " +
                $"{entry.GetProperty("createdAt").GetString()}");
        }

        // Every entry carries its provider and id, which are the two fields somebody searches
        // on once they know what they are looking for.
        Assert.All(
            events.EnumerateArray().ToArray(),
            entry =>
            {
                Assert.True(entry.TryGetProperty("eventId", out _));
                Assert.Contains(
                    entry.GetProperty("level").GetString(),
                    new[] { "critical", "error", "warning", "information", "verbose" });
            });
    }

    [Fact]
    public async Task A_level_filter_actually_filters()
    {
        JsonElement errors = Result(await RunAsync(
            "eventlog.query",
            new { log = "System", minimumLevel = "error", withinHours = 168, limit = 50 }));

        JsonElement everything = Result(await RunAsync(
            "eventlog.query",
            new { log = "System", minimumLevel = "information", withinHours = 168, limit = 50 }));

        _output.WriteLine(
            $"{errors.GetProperty("events").GetArrayLength()} error(s) vs " +
            $"{everything.GetProperty("events").GetArrayLength()} at information");

        // Nothing above `error` may appear in the error query. Level 0 is allowed through at
        // every threshold on purpose: providers use it for "no level given", and it is almost
        // always something worth seeing.
        Assert.All(
            errors.GetProperty("events").EnumerateArray().ToArray(),
            entry => Assert.Contains(
                entry.GetProperty("level").GetString(),
                new[] { "critical", "error", "information" }));
    }

    [Fact]
    public async Task A_log_WOLF_does_not_read_is_refused()
    {
        CommandExecution execution = await RunAsync("eventlog.query", new { log = "ForwardedEvents" });

        // The list is fixed rather than passed through. An arbitrary log name reaching the
        // event log reader would be one more string from the network deciding what a SYSTEM
        // process opens.
        Assert.NotNull(execution.Failure);
        Assert.Equal("invalid-payload", execution.Failure!.Code);
    }

    [Fact]
    public async Task The_hardware_inventory_reads_back_from_the_real_machine()
    {
        CommandExecution execution = await RunAsync("hardware.inventory", new { includeSerialNumbers = false });

        Succeeded(execution);

        JsonElement result = Result(execution);

        _output.WriteLine(
            $"{result.GetProperty("manufacturer").GetString()} {result.GetProperty("model").GetString()}");
        _output.WriteLine($"BIOS: {result.GetProperty("biosVendor").GetString()} {result.GetProperty("biosVersion").GetString()}");

        JsonElement cpu = result.GetProperty("cpu");
        if (cpu.ValueKind == JsonValueKind.Object)
        {
            _output.WriteLine($"CPU: {cpu.GetProperty("name").GetString()} ({cpu.GetProperty("cores").GetInt32()} cores)");
        }

        _output.WriteLine(
            $"{result.GetProperty("memoryModules").GetArrayLength()} memory module(s), " +
            $"{result.GetProperty("disks").GetArrayLength()} disk(s), " +
            $"{result.GetProperty("gpus").GetArrayLength()} GPU(s)");

        // A CPU is the one part every machine has and reports, virtual or not. Nothing at all
        // would mean the WMI query is wrong rather than the machine being unusual.
        Assert.Equal(JsonValueKind.Object, cpu.ValueKind);
        Assert.False(string.IsNullOrWhiteSpace(cpu.GetProperty("name").GetString()));
    }

    [Fact]
    public async Task Serial_numbers_are_left_out_unless_they_are_asked_for()
    {
        JsonElement without = Result(await RunAsync("hardware.inventory", new { includeSerialNumbers = false }));

        _output.WriteLine($"serialNumbersIncluded={without.GetProperty("serialNumbersIncluded").GetBoolean()}");

        // They are what an inventory is *for* — matching a machine to a warranty or an asset
        // register — and they are also a stable identifier for a physical object. Taking them
        // is a deliberate act rather than a side effect of asking what a PC is made of.
        Assert.False(without.GetProperty("serialNumbersIncluded").GetBoolean());
        Assert.Equal(JsonValueKind.Null, without.GetProperty("serialNumber").ValueKind);

        Assert.All(
            without.GetProperty("disks").EnumerateArray().ToArray(),
            disk => Assert.Equal(JsonValueKind.Null, disk.GetProperty("serialNumber").ValueKind));

        // And the flag travels with the answer, so a blank field is read as "not asked for"
        // rather than "this machine does not have one".
        JsonElement with = Result(await RunAsync("hardware.inventory", new { includeSerialNumbers = true }));
        Assert.True(with.GetProperty("serialNumbersIncluded").GetBoolean());
    }
}
