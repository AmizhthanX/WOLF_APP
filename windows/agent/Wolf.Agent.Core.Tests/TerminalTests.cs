using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Wolf.Agent.SessionHost.Terminal;
using Xunit;
using Xunit.Abstractions;

namespace Wolf.Agent.Core.Tests;

/// <summary>
/// The gate on running commands, and a real shell behind it.
///
/// This is the one feature in WOLF that is arbitrary command execution. Everything else the
/// agent does is a typed, allow-listed operation, and the reason a narrow surface is worth
/// having is that it bounds what a bug in the network-facing process can become. A terminal
/// has no such bound by definition, so what stands in its place is the checking in
/// <see cref="TerminalChannel"/> — and that is what most of these tests are about.
///
/// The shells here are real. A pseudo console is started, `cmd.exe` runs in it, and the
/// tests read what it printed. A mock would have proved that the plumbing calls itself in
/// the right order and nothing about whether a shell on this machine actually works.
/// </summary>
public sealed class TerminalTests
{
    private readonly ITestOutputHelper _output;

    public TerminalTests(ITestOutputHelper output)
    {
        _output = output;
    }

    private const string StreamId = "01J9ZQK7T0000000000000000B";
    private const string SessionId = "01J9ZQK7T0000000000000000A";
    private const string TerminalId = "01J9ZQK7T0000000000000000T";

    /* --------------------------------------------------------------------- */
    /* Harness                                                                */
    /* --------------------------------------------------------------------- */

    /// <summary>Collects what the channel sent towards the client, as the data channel would.</summary>
    private sealed class Sent
    {
        private readonly ConcurrentQueue<JsonNode> _messages = new();

        public void Add(JsonNode message) => _messages.Enqueue(message);

        public IReadOnlyList<JsonNode> Snapshot() => _messages.ToArray();

        public IEnumerable<JsonNode> OfKind(string kind) =>
            Snapshot().Where(message => message["kind"]?.GetValue<string>() == kind);

        /// <summary>Everything the shell printed, joined. Read by tests, never logged.</summary>
        public string Output() =>
            string.Concat(OfKind("terminal.output").Select(m => m["data"]?.GetValue<string>() ?? ""));

        /// <summary>Wait for something to become true, or give up and let the test say what it saw.</summary>
        public bool Await(Func<Sent, bool> condition, int seconds = 20)
        {
            DateTimeOffset deadline = DateTimeOffset.UtcNow.AddSeconds(seconds);

            while (DateTimeOffset.UtcNow < deadline)
            {
                if (condition(this)) return true;
                Thread.Sleep(50);
            }

            return condition(this);
        }
    }

    private static JsonElement Message(string json) =>
        JsonDocument.Parse(json).RootElement.Clone();

    private static JsonElement OpenMessage(
        string shell = "cmd",
        int columns = 120,
        int rows = 30,
        string terminalId = TerminalId,
        string extra = "") =>
        Message($$"""
            {
              "kind": "terminal.open",
              "streamId": "{{StreamId}}",
              "terminalId": "{{terminalId}}",
              "shell": {{JsonSerializer.Serialize(shell)}},
              "columns": {{columns}},
              "rows": {{rows}},
              "workingDirectory": null{{extra}}
            }
            """);

    private static JsonElement TypeMessage(string data, string terminalId = TerminalId) =>
        Message($$"""
            {"kind":"terminal.input","terminalId":"{{terminalId}}","data":{{JsonSerializer.Serialize(data)}}}
            """);

    private static TerminalChannel Channel(
        Sent sent,
        bool allowed = true,
        ILoggerFactory? loggers = null) =>
        new(StreamId, allowed, sent.Add, loggers ?? NullLoggerFactory.Instance);

    private static void Grant(TerminalChannel channel, int seconds = 300) =>
        channel.ApplyControl(true, SessionId, DateTimeOffset.UtcNow.AddSeconds(seconds));

    private static string Reason(JsonNode? node) => node?["reason"]?.GetValue<string>() ?? "(none)";

    /* --------------------------------------------------------------------- */
    /* A real shell                                                           */
    /* --------------------------------------------------------------------- */

    [Fact]
    public void A_shell_really_runs_and_prints_what_it_was_told_to()
    {
        const string Marker = "wolf-terminal-marker-8f21";

        var sent = new Sent();
        using TerminalChannel channel = Channel(sent);
        Grant(channel);

        JsonNode? opened = channel.Handle("terminal.open", OpenMessage());

        Assert.NotNull(opened);
        Assert.Equal("terminal.opened", opened!["kind"]!.GetValue<string>());

        int pid = opened["processId"]!.GetValue<int>();
        _output.WriteLine($"cmd.exe started as pid {pid}");

        // A real process, findable in the process list — which is the point of reporting it:
        // an audit trail in WOLF should line up with one on the machine itself.
        Assert.True(pid > 0);

        Assert.Null(channel.Handle("terminal.input", TypeMessage($"echo {Marker}\r\n")));

        Assert.True(
            sent.Await(s => s.Output().Contains(Marker, StringComparison.Ordinal)),
            "the shell never echoed the marker");

        // Not a mock answering itself: this string exists because cmd.exe on this machine
        // wrote it to a pseudo console and it came back through a pipe.
        Assert.Contains(Marker, sent.Output(), StringComparison.Ordinal);
    }

    [Fact]
    public void A_shell_that_exits_is_reported_once_and_with_its_code()
    {
        var sent = new Sent();
        using TerminalChannel channel = Channel(sent);
        Grant(channel);

        channel.Handle("terminal.open", OpenMessage());
        channel.Handle("terminal.input", TypeMessage("exit 3\r\n"));

        Assert.True(sent.Await(s => s.OfKind("terminal.exited").Any()), "the exit was never reported");

        JsonNode exited = sent.OfKind("terminal.exited").Single();
        _output.WriteLine(exited.ToJsonString());

        // Once, however it got here. The pipe closing and the process ending are two
        // different moments, and reporting both would have the client tear down a terminal
        // it had already torn down.
        Assert.Single(sent.OfKind("terminal.exited"));
        Assert.Equal("exited", exited["reason"]!.GetValue<string>());
        Assert.Equal(3, exited["exitCode"]!.GetValue<int>());

        // And the channel forgot it, so the id is free and typing into it is refused rather
        // than swallowed.
        Assert.Equal(0, channel.OpenTerminals);
    }

    [Fact]
    public void Closing_a_terminal_ends_the_process_on_the_machine()
    {
        var sent = new Sent();
        using TerminalChannel channel = Channel(sent);
        Grant(channel);

        JsonNode opened = channel.Handle("terminal.open", OpenMessage())!;
        int pid = opened["processId"]!.GetValue<int>();

        channel.Handle("terminal.close", Message($$"""{"kind":"terminal.close","terminalId":"{{TerminalId}}"}"""));

        Assert.True(sent.Await(s => s.OfKind("terminal.exited").Any()));
        Assert.Equal("closed", sent.OfKind("terminal.exited").Last()["reason"]!.GetValue<string>());

        // A shell that kept running after the operator closed it is a command prompt on
        // somebody's PC that nothing is watching.
        Assert.True(
            sent.Await(_ => !ProcessAlive(pid), seconds: 10),
            $"pid {pid} was still running after the terminal was closed");
    }

    [Fact]
    public void Ending_the_stream_takes_every_shell_with_it()
    {
        var sent = new Sent();
        int pid;

        using (TerminalChannel channel = Channel(sent))
        {
            Grant(channel);
            pid = channel.Handle("terminal.open", OpenMessage())!["processId"]!.GetValue<int>();
        }

        // Disposal is what happens when the viewer disconnects. Nothing else would close
        // these: the shell is perfectly happy to sit at a prompt forever.
        Assert.True(sent.Await(_ => !ProcessAlive(pid), seconds: 10), $"pid {pid} outlived its stream");
        Assert.Equal("stream-ended", sent.OfKind("terminal.exited").Last()["reason"]!.GetValue<string>());
    }

    private static bool ProcessAlive(int pid)
    {
        try
        {
            using var process = System.Diagnostics.Process.GetProcessById(pid);
            return !process.HasExited;
        }
        catch (ArgumentException)
        {
            return false;
        }
    }

    /* --------------------------------------------------------------------- */
    /* The gate                                                               */
    /* --------------------------------------------------------------------- */

    [Fact]
    public void A_session_that_was_not_granted_a_terminal_does_not_get_one()
    {
        var sent = new Sent();
        using TerminalChannel channel = Channel(sent, allowed: false);

        // Granted the lease and still refused, which is the point: the lease arbitrates
        // between sessions that may have a terminal. This one may not.
        Grant(channel);

        JsonNode? refused = channel.Handle("terminal.open", OpenMessage());

        _output.WriteLine(refused?.ToJsonString());

        Assert.Equal("terminal.refused", refused?["kind"]?.GetValue<string>());
        Assert.Equal("not-permitted", Reason(refused));
        Assert.Equal(0, channel.OpenTerminals);
    }

    [Fact]
    public void A_session_with_the_capability_but_no_lease_does_not_get_one()
    {
        var sent = new Sent();
        using TerminalChannel channel = Channel(sent);

        // The default is no. Being allowed a terminal is not the same as holding it, and a
        // session that was first to open a data channel must not get a shell for it.
        JsonNode? refused = channel.Handle("terminal.open", OpenMessage());

        Assert.Equal("not-permitted", Reason(refused));
        Assert.False(channel.HasControl);
        Assert.Equal(0, channel.OpenTerminals);
    }

    [Fact]
    public void An_expired_lease_does_not_get_one()
    {
        var sent = new Sent();
        using TerminalChannel channel = Channel(sent);

        // The case the expiry exists for: the cloud became unreachable. Nothing arrived to
        // revoke this, and it lapses anyway.
        channel.ApplyControl(true, SessionId, DateTimeOffset.UtcNow.AddSeconds(-1));

        Assert.False(channel.HasControl);
        Assert.Equal("not-permitted", Reason(channel.Handle("terminal.open", OpenMessage())));
    }

    [Fact]
    public void Losing_the_lease_closes_the_shells_it_opened()
    {
        var sent = new Sent();
        using TerminalChannel channel = Channel(sent);
        Grant(channel);

        int pid = channel.Handle("terminal.open", OpenMessage())!["processId"]!.GetValue<int>();

        channel.ApplyControl(granted: false, null, null);

        // This is the difference between a lease and a suggestion. A shell left running
        // after the lease lapsed would be inherited by whoever takes it next, half-typed
        // command and all.
        Assert.True(sent.Await(_ => !ProcessAlive(pid), seconds: 10), $"pid {pid} survived the lease");
        Assert.Equal(0, channel.OpenTerminals);
        Assert.Equal("not-permitted", Reason(channel.Handle("terminal.input", TypeMessage("whoami\r\n"))));
    }

    [Fact]
    public void An_elevated_terminal_is_refused_as_a_limitation_rather_than_quietly_served()
    {
        var sent = new Sent();
        using TerminalChannel channel = Channel(sent);
        Grant(channel);

        JsonNode? refused = channel.Handle(
            "terminal.open",
            OpenMessage(extra: ""","elevated":true"""));

        _output.WriteLine(refused?.ToJsonString());

        // `terminal-admin` is a separate capability and is not built. Handing back an
        // unelevated shell that says it is elevated would fail on the first thing it was
        // opened to do, and fail in a way that looks like a permissions bug on the machine.
        Assert.Equal("unsupported", Reason(refused));
        Assert.True(refused!["limitation"]!.GetValue<bool>());
        Assert.Equal(0, channel.OpenTerminals);
    }

    [Theory]
    [InlineData("notepad", "a program that is not a shell")]
    [InlineData("C:\\Windows\\System32\\cmd.exe", "a path rather than a name")]
    [InlineData("bash", "a shell WOLF does not start")]
    public void A_shell_that_is_not_on_the_list_is_refused(string shell, string description)
    {
        var sent = new Sent();
        using TerminalChannel channel = Channel(sent);
        Grant(channel);

        JsonNode? refused = channel.Handle("terminal.open", OpenMessage(shell: shell));

        _output.WriteLine($"{description}: {Reason(refused)}");

        // The whole point of naming shells rather than accepting paths. A caller that could
        // supply an executable would turn "give me a shell" into "run this program as the
        // signed-in user", before any shell exists to be audited as one.
        Assert.Equal("rejected", Reason(refused));
        Assert.Equal(0, channel.OpenTerminals);
    }

    [Theory]
    [InlineData(0, 30, "no columns at all")]
    [InlineData(5000, 30, "more columns than a console has")]
    [InlineData(120, 0, "no rows")]
    [InlineData(120, 9000, "more rows than a console has")]
    public void A_size_outside_its_bounds_is_refused(int columns, int rows, string description)
    {
        var sent = new Sent();
        using TerminalChannel channel = Channel(sent);
        Grant(channel);

        JsonNode? refused = channel.Handle("terminal.open", OpenMessage(columns: columns, rows: rows));

        _output.WriteLine($"{description}: {Reason(refused)}");

        // These reach CreatePseudoConsole as a console size. The protocol bounds them and
        // the cloud validates the signaling path, but terminal traffic does not travel it.
        Assert.Equal("rejected", Reason(refused));
        Assert.Equal(0, channel.OpenTerminals);
    }

    [Fact]
    public void More_typing_than_the_protocol_allows_is_refused_whole()
    {
        var sent = new Sent();
        using TerminalChannel channel = Channel(sent);
        Grant(channel);

        channel.Handle("terminal.open", OpenMessage());

        JsonNode? refused = channel.Handle(
            "terminal.input",
            TypeMessage(new string('a', TerminalChannel.MaxChunkChars + 1)));

        // Refused rather than truncated: half a command is a different command, and this one
        // runs on somebody's PC.
        Assert.Equal("rejected", Reason(refused));
    }

    [Fact]
    public void A_stream_may_not_open_more_shells_than_it_is_allowed()
    {
        var sent = new Sent();
        using TerminalChannel channel = Channel(sent);
        Grant(channel);

        for (int index = 0; index < TerminalChannel.MaxTerminals; index++)
        {
            JsonNode? opened = channel.Handle(
                "terminal.open",
                OpenMessage(terminalId: $"01J9ZQK7T000000000000000{index}0"));

            Assert.Equal("terminal.opened", opened?["kind"]?.GetValue<string>());
        }

        JsonNode? refused = channel.Handle("terminal.open", OpenMessage(terminalId: TerminalId));

        // Each of these is a process on somebody's machine. Opening them without bound is a
        // denial of service against the PC the operator is trying to fix.
        Assert.Equal("too-many", Reason(refused));
        Assert.Equal(TerminalChannel.MaxTerminals, channel.OpenTerminals);
    }

    [Fact]
    public void Typing_into_a_terminal_that_is_not_open_is_answered_rather_than_dropped()
    {
        var sent = new Sent();
        using TerminalChannel channel = Channel(sent);
        Grant(channel);

        // An operator typing into a shell that is not there needs to know which of the
        // several possible reasons applies. Silence is the one answer that helps nobody.
        Assert.Equal("unknown-terminal", Reason(channel.Handle("terminal.input", TypeMessage("dir\r\n"))));
        Assert.Equal(
            "unknown-terminal",
            Reason(channel.Handle(
                "terminal.close",
                Message($$"""{"kind":"terminal.close","terminalId":"{{TerminalId}}"}"""))));
    }

    /* --------------------------------------------------------------------- */
    /* What gets said about it                                                */
    /* --------------------------------------------------------------------- */

    [Fact]
    public void Nothing_typed_or_printed_reaches_the_log()
    {
        const string Secret = "hunter2-correct-horse-battery";

        var recorder = new RecordingLogs();
        var sent = new Sent();
        using TerminalChannel channel = Channel(sent, loggers: recorder);
        Grant(channel);

        channel.Handle("terminal.open", OpenMessage());
        channel.Handle("terminal.input", TypeMessage($"echo {Secret}\r\n"));

        Assert.True(sent.Await(s => s.Output().Contains(Secret, StringComparison.Ordinal)));

        foreach (string line in recorder.Messages) _output.WriteLine(line);

        // Rule six, on the path where it is least theoretical. Terminal output routinely
        // contains a connection string a script echoed, a token in an environment dump, or a
        // password typed into a prompt that was not hiding it. What the log carries is which
        // shell, which stream, which pid, and how many bytes.
        Assert.DoesNotContain(recorder.Messages, m => m.Contains(Secret, StringComparison.Ordinal));
        Assert.Contains(recorder.Messages, m => m.Contains("opened a cmd terminal", StringComparison.Ordinal));
    }

    [Fact]
    public void A_refusal_says_the_code_and_not_the_message_it_refused()
    {
        const string Secret = "not-in-the-log-either-9931";

        var recorder = new RecordingLogs();
        var sent = new Sent();
        using TerminalChannel channel = Channel(sent, loggers: recorder);
        Grant(channel);

        channel.Handle("terminal.open", OpenMessage());
        channel.Handle("terminal.input", TypeMessage(new string('x', TerminalChannel.MaxChunkChars) + Secret));

        Assert.Contains(recorder.Messages, m => m.Contains("refused (rejected)", StringComparison.Ordinal));

        // A refusal that quoted what it refused would put a half-typed password in the log
        // of every PC that ever refused one.
        Assert.DoesNotContain(recorder.Messages, m => m.Contains(Secret, StringComparison.Ordinal));
    }

    /* --------------------------------------------------------------------- */
    /* The allow-list                                                         */
    /* --------------------------------------------------------------------- */

    [Fact]
    public void Every_named_shell_either_resolves_to_a_real_file_or_says_it_is_not_installed()
    {
        foreach (string name in ShellCatalogue.Names)
        {
            ResolvedShell? shell = ShellCatalogue.Resolve(name);

            _output.WriteLine($"{name}: {shell?.ExecutablePath ?? "not installed"}");

            // Null is a real answer on a real machine — PowerShell 7 is an optional install.
            // What must never happen is a resolved shell pointing at a path that is not
            // there, because that becomes a launch failure nobody can diagnose.
            if (shell is not null) Assert.True(File.Exists(shell.ExecutablePath));
        }

        // cmd.exe is on every Windows machine there has ever been. If this is null, the
        // resolution is wrong rather than the machine being unusual.
        Assert.NotNull(ShellCatalogue.Resolve("cmd"));
    }

    [Fact]
    public void Argument_zero_is_quoted_so_a_path_with_a_space_cannot_become_another_program()
    {
        ResolvedShell shell = ShellCatalogue.Resolve("cmd")!;

        _output.WriteLine(shell.CommandLine);

        // These paths do not have spaces today, and relying on that is how they acquire one.
        // An unquoted `C:\Program Files\...` runs `C:\Program.exe`.
        Assert.StartsWith("\"", shell.CommandLine, StringComparison.Ordinal);
        Assert.Contains("\" ", shell.CommandLine + " ", StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("")]
    [InlineData("CMD")]
    [InlineData("cmd.exe")]
    [InlineData("..\\..\\Windows\\System32\\cmd.exe")]
    public void Anything_that_is_not_one_of_the_names_resolves_to_nothing(string name)
    {
        // Including the ones that look close. A case-insensitive or suffix-tolerant match
        // here would be the beginning of accepting paths.
        Assert.Null(ShellCatalogue.Resolve(name));
    }

    /* --------------------------------------------------------------------- */

    /// <summary>Keeps every logged line so a test can assert what is <em>not</em> in it.</summary>
    private sealed class RecordingLogs : ILoggerFactory
    {
        private readonly ConcurrentQueue<string> _messages = new();

        public IReadOnlyCollection<string> Messages => _messages;

        public ILogger CreateLogger(string categoryName) => new Recorder(_messages, categoryName);

        public void AddProvider(ILoggerProvider provider)
        {
        }

        public void Dispose()
        {
        }

        private sealed class Recorder : ILogger
        {
            private readonly ConcurrentQueue<string> _messages;
            private readonly string _category;

            public Recorder(ConcurrentQueue<string> messages, string category)
            {
                _messages = messages;
                _category = category;
            }

            public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

            // Every level, on purpose: a recorder that filtered would pass the "no secret in
            // the log" test by never seeing the line that would have carried one.
            public bool IsEnabled(LogLevel logLevel) => true;

            public void Log<TState>(
                LogLevel logLevel,
                EventId eventId,
                TState state,
                Exception? exception,
                Func<TState, Exception?, string> formatter) =>
                _messages.Enqueue($"[{logLevel}] {_category}: {formatter(state, exception)}");
        }
    }
}
