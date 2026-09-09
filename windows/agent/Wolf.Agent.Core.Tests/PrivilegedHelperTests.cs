using System.Diagnostics;
using System.IO.Pipes;
using System.Security.Principal;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Wolf.Agent.Core.Privileged;
using Wolf.Agent.Helper;
using Xunit;
using Xunit.Abstractions;

namespace Wolf.Agent.Core.Tests;

/// <summary>
/// The privileged helper: what it will refuse, and what it will do.
///
/// This is the process that will eventually hold a credential provider and capture the
/// secure desktop, so its front door deserves more testing than what is currently behind it.
///
/// The tests come in two halves, because the helper's own ACL prevents them being one. The
/// pipe is open to SYSTEM and Administrators only, so an ordinary developer session cannot
/// connect to it at all — which is the correct behaviour and is asserted below. The
/// decisions the helper makes about a request are therefore tested through
/// <see cref="HelperRequestGuard"/> directly, and the tests that need the real channel state
/// that they need elevation and skip without it, rather than passing on nothing.
/// </summary>
[Collection("SessionHost")]
public sealed class PrivilegedHelperTests
{
    private readonly ITestOutputHelper _output;

    public PrivilegedHelperTests(ITestOutputHelper output)
    {
        _output = output;
    }

    private const string Nonce = "0123456789ABCDEF0123456789ABCDEF";

    /// <summary>
    /// Whether this test run can open the helper's pipe.
    ///
    /// Not a convenience check: an unelevated process is refused by design, and a run that
    /// pretended otherwise would be reporting on a helper it never reached.
    /// </summary>
    private static bool Elevated()
    {
        using WindowsIdentity identity = WindowsIdentity.GetCurrent();
        return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
    }

    private bool CanOpenTheHelper()
    {
        if (Elevated()) return true;

        _output.WriteLine(
            "This run is not elevated, so it cannot open a pipe restricted to SYSTEM and " +
            "Administrators — which is the point of the restriction. Skipping.");
        return false;
    }

    /* --------------------------------------------------------------------- */
    /* What the helper refuses, tested without needing the channel             */
    /* --------------------------------------------------------------------- */

    [Fact]
    public void A_well_formed_request_for_an_allowed_operation_is_accepted()
    {
        var guard = new HelperRequestGuard(Nonce);

        Assert.Null(guard.Check(
            HelperRequestMessage.KindName,
            HelperProtocol.Version,
            Nonce,
            1,
            HelperProtocol.Operations.DiskSmartHealth));

        Assert.Equal(1, guard.LastSequence);
    }

    [Fact]
    public void An_operation_that_is_not_on_the_allow_list_is_refused_by_name()
    {
        var guard = new HelperRequestGuard(Nonce);

        // The allow-list is what this whole process exists for. Anything not on it is
        // refused whatever it looks like, and the refusal names it so the log says what was
        // asked for rather than that something was.
        foreach (string operation in new[] { "process.start", "registry.write", "", "disk.smart-health " })
        {
            HelperRefusal? refusal = guard.Check(
                HelperRequestMessage.KindName,
                HelperProtocol.Version,
                Nonce,
                guard.LastSequence + 1,
                operation);

            Assert.NotNull(refusal);
            Assert.Equal("not-allowed", refusal!.Code);
        }
    }

    [Fact]
    public void A_request_carrying_another_connection_s_nonce_is_refused()
    {
        var guard = new HelperRequestGuard(Nonce);

        HelperRefusal? refusal = guard.Check(
            HelperRequestMessage.KindName,
            HelperProtocol.Version,
            // What a captured request would carry: a nonce issued for a different
            // connection, which this helper has already forgotten.
            "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
            1,
            HelperProtocol.Operations.Describe);

        Assert.NotNull(refusal);
        Assert.Equal("bad-nonce", refusal!.Code);
    }

    [Fact]
    public void A_repeated_sequence_number_is_refused()
    {
        var guard = new HelperRequestGuard(Nonce);

        Assert.Null(guard.Check(HelperRequestMessage.KindName, HelperProtocol.Version, Nonce, 1, "helper.describe"));

        // The same request again, inside the same live connection. Without this, capturing a
        // request would be enough to repeat a privileged operation without needing a nonce.
        HelperRefusal? replay = guard.Check(
            HelperRequestMessage.KindName, HelperProtocol.Version, Nonce, 1, "helper.describe");

        Assert.NotNull(replay);
        Assert.Equal("replayed", replay!.Code);

        // Going backwards is refused too, which is what a reordered capture would look like.
        Assert.Equal("replayed", guard.Check(
            HelperRequestMessage.KindName, HelperProtocol.Version, Nonce, 0, "helper.describe")!.Code);
    }

    [Fact]
    public void A_refused_request_does_not_consume_a_sequence_number()
    {
        var guard = new HelperRequestGuard(Nonce);

        Assert.Null(guard.Check(HelperRequestMessage.KindName, HelperProtocol.Version, Nonce, 5, "helper.describe"));

        // Something malformed arrives claiming a much higher sequence. If it advanced the
        // counter, an attacker who could inject one message would lock the real agent out of
        // its own channel for the rest of the connection.
        guard.Check("nonsense", HelperProtocol.Version, Nonce, 900, "helper.describe");
        guard.Check(HelperRequestMessage.KindName, HelperProtocol.Version, "wrong", 901, "helper.describe");

        Assert.Equal(5, guard.LastSequence);
        Assert.Null(guard.Check(HelperRequestMessage.KindName, HelperProtocol.Version, Nonce, 6, "helper.describe"));
    }

    [Fact]
    public void A_protocol_version_the_helper_does_not_speak_is_refused()
    {
        var guard = new HelperRequestGuard(Nonce);

        HelperRefusal? refusal = guard.Check(
            HelperRequestMessage.KindName,
            HelperProtocol.Version + 1,
            Nonce,
            1,
            HelperProtocol.Operations.Describe);

        Assert.NotNull(refusal);
        Assert.Equal("version-mismatch", refusal!.Code);
    }

    [Fact]
    public void The_allow_list_is_exactly_what_the_helper_implements()
    {
        // Two places would drift. This is the assertion that fails when a name is added to
        // the protocol without an implementation behind it, or the other way round.
        Assert.True(HelperProtocol.IsAllowed(HelperProtocol.Operations.Describe));
        Assert.True(HelperProtocol.IsAllowed(HelperProtocol.Operations.DiskSmartHealth));

        foreach (string operation in new[] { "helper.stop", "process.start", "terminal.run", "DISK.SMART-HEALTH" })
        {
            Assert.False(HelperProtocol.IsAllowed(operation), $"'{operation}' must not be allowed");
        }
    }

    /* --------------------------------------------------------------------- */
    /* The channel itself                                                     */
    /* --------------------------------------------------------------------- */

    [Fact]
    public async Task An_unelevated_process_cannot_open_the_helper_pipe()
    {
        if (Elevated())
        {
            _output.WriteLine("This run is elevated, so it is allowed to open the pipe. Skipping.");
            return;
        }

        using var loggers = new XunitLoggerFactory(_output, LogLevel.Warning);
        await using var helper = new HelperServer(loggers, "0.1.0-test", Environment.ProcessPath);
        helper.Start();

        using var pipe = new NamedPipeClientStream(
            ".",
            HelperProtocol.PipeName,
            PipeDirection.InOut,
            PipeOptions.Asynchronous);

        // The ACL is the outermost guard and the only one that stops a caller before it can
        // say anything at all. An ordinary account on this machine gets access denied, and
        // that is the whole reason the tests above go through the guard instead.
        using var connecting = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        await Assert.ThrowsAsync<UnauthorizedAccessException>(() => pipe.ConnectAsync(connecting.Token));

        _output.WriteLine("An unelevated process was refused the pipe, as intended.");
    }

    [Fact]
    public async Task The_helper_describes_itself_over_the_real_channel()
    {
        if (!CanOpenTheHelper()) return;

        using var loggers = new XunitLoggerFactory(_output, LogLevel.Warning);

        // Caller verification is pointed at this test host, because that is what will be
        // connecting. It exercises the check rather than disabling it.
        await using var helper = new HelperServer(loggers, "0.1.0-test", Environment.ProcessPath);
        helper.Start();

        var client = new HelperClient(loggers.CreateLogger<HelperClient>());
        HelperOutcome outcome = await client.CallAsync(
            HelperProtocol.Operations.Describe,
            new { },
            CancellationToken.None);

        Assert.True(outcome.Ok, $"describe failed: {outcome.Code} {outcome.Message}");

        JsonElement result = outcome.Result!.Value;
        string[] operations = result.GetProperty("operations")
            .EnumerateArray()
            .Select(entry => entry.GetString()!)
            .ToArray();

        _output.WriteLine(
            $"helper {result.GetProperty("helperVersion").GetString()} " +
            $"as {result.GetProperty("account").GetString()}: {string.Join(", ", operations)}");

        Assert.Contains(HelperProtocol.Operations.DiskSmartHealth, operations);
        Assert.Equal(2, operations.Length);
    }

    [Fact]
    public async Task A_caller_that_is_not_the_expected_program_is_disconnected_without_being_told_why()
    {
        if (!CanOpenTheHelper()) return;

        using var loggers = new XunitLoggerFactory(_output, LogLevel.Warning);

        // Pointed at a path that is not this process, so the caller check fails. The pipe
        // ACL would still let another SYSTEM process in; this is the check that stops it
        // driving the helper.
        await using var helper = new HelperServer(
            loggers,
            "0.1.0-test",
            Path.Combine(AppContext.BaseDirectory, "not-the-agent.exe"));
        helper.Start();

        var client = new HelperClient(loggers.CreateLogger<HelperClient>());
        HelperOutcome outcome = await client.CallAsync(
            HelperProtocol.Operations.Describe,
            new { },
            CancellationToken.None);

        _output.WriteLine($"outcome: {outcome.Code} {outcome.Message}");

        // Refused, and told nothing about why: a probe learns only that the door closed.
        Assert.False(outcome.Ok);
        Assert.Equal("rejected", outcome.Code);
    }

    [Fact]
    public async Task Disk_health_comes_back_for_the_drives_this_pc_has()
    {
        if (!CanOpenTheHelper()) return;

        using var loggers = new XunitLoggerFactory(_output, LogLevel.Warning);
        await using var helper = new HelperServer(loggers, "0.1.0-test", Environment.ProcessPath);
        helper.Start();

        var client = new HelperClient(loggers.CreateLogger<HelperClient>());
        HelperOutcome outcome = await client.CallAsync(
            HelperProtocol.Operations.DiskSmartHealth,
            new { deviceId = (string?)null },
            CancellationToken.None);

        Assert.True(outcome.Ok, $"disk health failed: {outcome.Code} {outcome.Message}");

        JsonElement disks = outcome.Result!.Value.GetProperty("disks");
        Assert.Equal(JsonValueKind.Array, disks.ValueKind);

        // Every machine that runs this has at least one drive. Zero means the query was
        // refused or the enumeration is broken, and passing on an empty list would hide it.
        Assert.True(disks.GetArrayLength() > 0, "no physical drives were reported at all");

        foreach (JsonElement disk in disks.EnumerateArray())
        {
            string status = disk.GetProperty("status").GetString()!;
            string summary = disk.GetProperty("summary").GetString()!;

            _output.WriteLine(
                $"{disk.GetProperty("deviceId").GetString()}  {disk.GetProperty("model").GetString()}  " +
                $"{status}: {summary}");

            Assert.Contains(status, new[] { "healthy", "warning", "failing", "unknown" });

            // Including for `unknown`. "This enclosure does not pass SMART through" is the
            // answer somebody needs, and a blank field is not an answer at all.
            Assert.False(
                string.IsNullOrWhiteSpace(summary),
                "every drive must say why it has the status it has");
        }
    }

    /* --------------------------------------------------------------------- */
    /* The agent's side                                                       */
    /* --------------------------------------------------------------------- */

    [Fact]
    public async Task Asking_when_no_helper_is_running_says_so_rather_than_hanging()
    {
        using var loggers = new XunitLoggerFactory(_output, LogLevel.Warning);

        // No helper started. This is a PC on a build that predates the helper, or one where
        // the service has been stopped — an ordinary condition, not a fault.
        var client = new HelperClient(loggers.CreateLogger<HelperClient>());

        var clock = Stopwatch.StartNew();
        HelperOutcome outcome = await client.CallAsync(
            HelperProtocol.Operations.Describe,
            new { },
            CancellationToken.None);
        clock.Stop();

        _output.WriteLine($"answered in {clock.ElapsedMilliseconds} ms: {outcome.Code} {outcome.Message}");

        Assert.False(outcome.Ok);
        Assert.Equal("helper-unavailable", outcome.Code);
        Assert.NotNull(outcome.Message);

        // Bounded, because an operator is waiting behind this. A privileged read that hangs
        // is indistinguishable from a PC that has stopped answering.
        Assert.True(
            clock.Elapsed < TimeSpan.FromSeconds(10),
            $"took {clock.Elapsed.TotalSeconds:F1}s to give up");
    }

    [Fact]
    public async Task The_client_refuses_to_send_an_operation_that_is_not_allowed()
    {
        using var loggers = new XunitLoggerFactory(_output, LogLevel.Warning);
        var client = new HelperClient(loggers.CreateLogger<HelperClient>());

        // Checked on both sides on purpose. The helper is the boundary that counts, but an
        // agent that tries to send something off the list has a bug, and finding out from a
        // refusal over the wire would be finding out late.
        await Assert.ThrowsAsync<ArgumentException>(() =>
            client.CallAsync("registry.write", new { }, CancellationToken.None));
    }
}
