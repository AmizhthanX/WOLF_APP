using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Wolf.Agent.Core.Ipc;
using Wolf.Agent.SessionHost;
using Wolf.Agent.SessionHost.Displays;
using Wolf.Agent.SessionHost.Input;
using Xunit;
using Xunit.Abstractions;

namespace Wolf.Agent.Core.Tests;

/// <summary>
/// Typing on the lock screen.
///
/// This is what makes seeing the secure desktop worth anything: the operator watches their own
/// PC's lock screen and signs in to it, typing their password themselves as keystrokes on an
/// encrypted stream. WOLF never stores it, never logs it, and has no idea which of the
/// keystrokes it was. That is a different claim from "WOLF can unlock your PC" — see
/// <c>docs/architecture/remote-unlock.md</c> for why the stronger one is not available.
///
/// The path has three parts and the middle one has never run:
///
///  1. <see cref="InputChannel"/> authorises the batch, exactly as it always does, and then
///     forwards it instead of injecting it. Runs here, and is tested here for real.
///  2. The service carries it to the host on the secure desktop. Needs the agent installed as
///     a service and a locked screen; what is tested here is the encoding, which is the part
///     that would corrupt it quietly.
///  3. <see cref="SecureInputSink"/> injects what it is handed. The desktop it will run on is
///     unreachable from a test, but the class is not — so it is exercised on this one.
///
/// The security question these answer is the one worth answering: **forwarding must not be a
/// way round the lease.** Every check that stood between a stranger's keystroke and somebody's
/// keyboard still stands when the destination changes.
/// </summary>
[Collection("Capture")]
public sealed class SecureInputTests
{
    private readonly ITestOutputHelper _output;

    public SecureInputTests(ITestOutputHelper output)
    {
        _output = output;
    }

    private const string StreamId = "01J9ZQK7T0000000000000000B";
    private const string SessionId = "01J9ZQK7T0000000000000000A";

    /// <summary>F24: a key that exists in the virtual-key table and on almost no keyboard.</summary>
    private const int HarmlessKey = 0x87;

    private static readonly IpcDisplay Display =
        new("\\\\.\\DISPLAY1", "Test", 1920, 1080, 60, true, 1, false, 0, 0);

    private static InputChannel Channel(ILogger<InputChannel>? logger = null) => new(
        StreamId,
        new InputInjector(Display, NullLogger<InputInjector>.Instance),
        logger ?? NullLogger<InputChannel>.Instance);

    private static JsonElement Batch(string streamId, long sequence, string events) =>
        JsonDocument.Parse(
            $$"""
            {
              "streamId": "{{streamId}}",
              "sequence": {{sequence}},
              "sentAt": "2026-01-01T00:00:00.000Z",
              "events": {{events}}
            }
            """).RootElement.Clone();

    private static JsonElement KeyBatch(long sequence = 0, int key = HarmlessKey, string streamId = StreamId) =>
        Batch(streamId, sequence, $$"""
            [{"type":"key","key":{{key}},"action":"down","scanCode":null,"extended":false,"offsetMs":0}]
            """);

    private static void Grant(InputChannel channel) =>
        channel.ApplyControl(true, SessionId, DateTimeOffset.UtcNow.AddSeconds(120));

    /* --------------------------------------------------------------------- */
    /* Where the events go                                                    */
    /* --------------------------------------------------------------------- */

    [Fact]
    public void While_the_lock_screen_is_showing_input_leaves_this_desktop()
    {
        InputChannel channel = Channel();
        Grant(channel);

        var forwarded = new List<JsonElement>();
        channel.ForwardTo(forwarded.Add);

        using var hook = new KeyboardHook();
        InputRejection? rejection = null;
        hook.Run(() => rejection = channel.Handle(KeyBatch()));

        _output.WriteLine($"forwarded {forwarded.Count}; observed {hook.Events.Count} key event(s)");

        Assert.Null(rejection);
        Assert.Single(forwarded);

        // The important half. This process cannot reach the secure desktop, so injecting here
        // as well would type the operator's password into whatever has focus on their own
        // session — a lock screen showing on the client, and a password manager receiving it.
        Assert.DoesNotContain(hook.Events, e => e.VirtualKey == HarmlessKey && e.Injected);

        // Counted, because from the session's point of view the events left having passed
        // every check. What happened on the other desktop is that host's to report.
        Assert.Equal(1, channel.EventsInjected);
    }

    [Fact]
    public void The_forwarded_batch_is_the_one_the_client_sent()
    {
        InputChannel channel = Channel();
        Grant(channel);

        JsonElement? seen = null;
        channel.ForwardTo(batch => seen = batch);

        channel.Handle(KeyBatch(sequence: 7));

        Assert.NotNull(seen);

        // Forwarded verbatim rather than re-serialised from the parsed events. Re-encoding
        // would mean the far end injects this process' idea of what the client meant, and
        // every field WOLF has not thought about yet would be dropped in the middle.
        Assert.Equal(StreamId, seen!.Value.GetProperty("streamId").GetString());
        Assert.Equal(7, seen.Value.GetProperty("sequence").GetInt64());
        Assert.Equal(1, seen.Value.GetProperty("events").GetArrayLength());
        Assert.Equal(
            HarmlessKey,
            seen.Value.GetProperty("events")[0].GetProperty("key").GetInt32());
    }

    [Fact]
    public void Unlocking_puts_input_back_on_this_desktop()
    {
        InputChannel channel = Channel();
        Grant(channel);

        var forwarded = new List<JsonElement>();
        channel.ForwardTo(forwarded.Add);
        channel.ForwardTo(null);

        using var hook = new KeyboardHook();
        hook.Run(() => channel.Handle(KeyBatch()));

        // The screen unlocked and the client is looking at the desktop again. Input that kept
        // going to a host that no longer exists would be a session that silently stopped
        // responding to the keyboard.
        Assert.Empty(forwarded);
        Assert.Contains(hook.Events, e => e.VirtualKey == HarmlessKey && e.Injected);
    }

    /* --------------------------------------------------------------------- */
    /* Forwarding is not a way round the lease                                */
    /* --------------------------------------------------------------------- */

    [Fact]
    public void A_session_that_does_not_hold_control_forwards_nothing()
    {
        InputChannel channel = Channel();

        var forwarded = new List<JsonElement>();
        channel.ForwardTo(forwarded.Add);

        InputRejection? rejection = channel.Handle(KeyBatch());

        _output.WriteLine(rejection?.Reason);

        // A lock screen is the most valuable thing on the machine to be able to type on.
        // Never having been granted control has to mean the same here as anywhere else.
        Assert.NotNull(rejection);
        Assert.Equal("not-permitted", rejection!.Outcome);
        Assert.Empty(forwarded);
        Assert.Equal(0, channel.EventsInjected);
    }

    [Fact]
    public void An_expired_lease_forwards_nothing()
    {
        InputChannel channel = Channel();
        channel.ApplyControl(true, SessionId, DateTimeOffset.UtcNow.AddSeconds(-1));

        var forwarded = new List<JsonElement>();
        channel.ForwardTo(forwarded.Add);

        InputRejection? rejection = channel.Handle(KeyBatch());

        // The case that matters: the cloud became unreachable while the screen was locked.
        // The lease still lapses, and the PC does not stay typeable by whoever held it last.
        Assert.NotNull(rejection);
        Assert.Equal("not-permitted", rejection!.Outcome);
        Assert.Empty(forwarded);
    }

    [Fact]
    public void Revoking_control_while_the_lock_screen_is_showing_stops_it_at_once()
    {
        InputChannel channel = Channel();
        Grant(channel);

        var forwarded = new List<JsonElement>();
        channel.ForwardTo(forwarded.Add);

        channel.Handle(KeyBatch(sequence: 0));
        Assert.Single(forwarded);

        channel.ApplyControl(granted: false, null, null);

        Assert.NotNull(channel.Handle(KeyBatch(sequence: 1)));
        Assert.Single(forwarded);
    }

    [Theory]
    [InlineData("""[{"type":"key","key":900,"action":"down","extended":false,"offsetMs":0}]""", "a key above 254")]
    [InlineData("""[{"type":"pointer.move","x":4,"y":0.5,"offsetMs":0}]""", "a coordinate outside 0..1")]
    [InlineData("""[{"type":"exec","value":"whoami","offsetMs":0}]""", "an event type that does not exist")]
    public void A_batch_the_protocol_does_not_allow_is_refused_before_it_is_forwarded(
        string events,
        string description)
    {
        InputChannel channel = Channel();
        Grant(channel);

        var forwarded = new List<JsonElement>();
        channel.ForwardTo(forwarded.Add);

        InputRejection? rejection = channel.Handle(Batch(StreamId, 0, events));

        _output.WriteLine($"{description}: {rejection?.Reason ?? "ACCEPTED"}");

        // Bounds are checked here rather than on the secure desktop, because the far end is
        // deliberately incapable of judging anything: it injects what it is handed.
        Assert.NotNull(rejection);
        Assert.Empty(forwarded);
    }

    [Theory]
    [InlineData("ctrl-alt-del")]
    [InlineData("alt-tab")]
    public void A_system_combination_is_refused_with_a_reason_rather_than_forwarded_into_silence(
        string combo)
    {
        InputChannel channel = Channel();
        Grant(channel);

        var forwarded = new List<JsonElement>();
        channel.ForwardTo(forwarded.Add);

        InputRejection? rejection = channel.Handle(
            Batch(StreamId, 0, $$"""[{"type":"system.combo","combo":"{{combo}}","offsetMs":0}]"""));

        _output.WriteLine($"{combo}: {rejection?.Reason ?? "ACCEPTED"}");

        // Ctrl+Alt+Delete is Winlogon's to produce and injected input cannot stand in for it;
        // Alt+Tab addresses a desktop that is not the one being shown. The far end has no
        // route back to the client, so forwarding either would be a keypress that vanished.
        Assert.NotNull(rejection);
        Assert.Equal("unsupported", rejection!.Outcome);
        Assert.True(rejection.Limitation);
        Assert.Empty(forwarded);
    }

    [Fact]
    public void A_batch_for_another_stream_is_not_forwarded_either()
    {
        InputChannel channel = Channel();
        Grant(channel);

        var forwarded = new List<JsonElement>();
        channel.ForwardTo(forwarded.Add);

        InputRejection? rejection = channel.Handle(
            KeyBatch(streamId: "01J9ZQK7T0000000000000000Z"));

        Assert.NotNull(rejection);
        Assert.Equal("rejected", rejection!.Outcome);
        Assert.Empty(forwarded);
    }

    /* --------------------------------------------------------------------- */
    /* What gets said about it                                                */
    /* --------------------------------------------------------------------- */

    [Fact]
    public void Nothing_about_a_forwarded_keystroke_reaches_the_log()
    {
        const string Password = "correct-horse-battery-staple";

        var recorder = new RecordingLoggerFactory();
        InputChannel channel = Channel(recorder.CreateLogger<InputChannel>());
        Grant(channel);

        channel.ForwardTo(_ => { });

        InputRejection? rejection = channel.Handle(
            Batch(StreamId, 3, $$"""[{"type":"text","value":"{{Password}}","offsetMs":0}]"""));

        Assert.Null(rejection);

        foreach (string line in recorder.Messages) _output.WriteLine(line);

        // Rule six, on the one path where it is not theoretical. Everything logged about a
        // forwarded batch is a count and a stream id, and the recorder is at Debug so the
        // line that does exist is really being looked at.
        Assert.Contains(recorder.Messages, m => m.Contains("forwarded", StringComparison.Ordinal));
        Assert.DoesNotContain(recorder.Messages, m => m.Contains(Password, StringComparison.Ordinal));
    }

    /* --------------------------------------------------------------------- */
    /* The far end, on the desktop it can be run on                           */
    /* --------------------------------------------------------------------- */

    private static SecureInputSink Sink(ILoggerFactory loggers) =>
        new(new DisplayEnumerator(loggers.CreateLogger<DisplayEnumerator>()), loggers);

    [Fact]
    public void The_sink_injects_what_it_is_handed_without_a_lease_of_its_own()
    {
        SecureInputSink sink = Sink(NullLoggerFactory.Instance);

        using var hook = new KeyboardHook();
        hook.Run(() => sink.Inject(StreamId, KeyBatch()));

        _output.WriteLine($"observed {hook.Events.Count} key event(s); {sink.Batches} batch(es)");

        // Nothing granted this sink control, and that is the design: the host that holds the
        // session checked the lease before forwarding, and this process has no session to
        // check one against. It must not pretend to make a decision it cannot make.
        Assert.Contains(hook.Events, e => e.VirtualKey == HarmlessKey && e.Injected);
        Assert.Equal(1, sink.Batches);
    }

    [Fact]
    public void The_sink_still_refuses_an_event_outside_its_bounds()
    {
        var recorder = new RecordingLoggerFactory();
        SecureInputSink sink = Sink(recorder);

        using var hook = new KeyboardHook();
        hook.Run(() => sink.Inject(
            StreamId,
            Batch(StreamId, 0, """[{"type":"key","key":900,"action":"down","extended":false,"offsetMs":0}]""")));

        foreach (string line in recorder.Messages) _output.WriteLine(line);

        // Authorised does not mean well-formed. A batch that passed the lease check and then
        // asked for virtual key 900 is a bug or a probe, and either way nothing is injected.
        Assert.Empty(hook.Events);
        Assert.Contains(recorder.Messages, m => m.Contains("refused", StringComparison.Ordinal));
    }

    [Fact]
    public void The_sink_serves_one_stream_at_a_time_and_switches_cleanly()
    {
        const string Other = "01J9ZQK7T0000000000000000C";

        SecureInputSink sink = Sink(NullLoggerFactory.Instance);

        using var hook = new KeyboardHook();
        hook.Run(() =>
        {
            sink.Inject(StreamId, KeyBatch());
            sink.Inject(Other, KeyBatch(streamId: Other));
            sink.Inject(StreamId, KeyBatch());
        });

        // A second operator reconnecting while the screen is still locked gets a new channel
        // rather than batches refused for belonging to the stream that has gone. There is no
        // reset for this: the sink rebuilds on a stream it has not seen, and the host itself
        // is killed the moment the screen unlocks.
        Assert.Equal(3, sink.Batches);
        Assert.Equal(3, hook.Events.Count(e => e.VirtualKey == HarmlessKey && e.Injected));
    }

    /* --------------------------------------------------------------------- */
    /* The two hops in between                                                */
    /* --------------------------------------------------------------------- */

    [Fact]
    public void An_authorised_batch_survives_both_pipes_verbatim()
    {
        JsonElement original = KeyBatch(sequence: 12);

        // Hop one: the user host to the service.
        string first = JsonSerializer.Serialize(
            new HostSecureInputMessage(StreamId, original), WolfIpc.Json);
        HostSecureInputMessage atService =
            JsonSerializer.Deserialize<HostSecureInputMessage>(first, WolfIpc.Json)!;

        // Hop two: the service to the host on the secure desktop.
        string second = JsonSerializer.Serialize(
            new ServiceSecureInputMessage(atService.StreamId, atService.Batch), WolfIpc.Json);
        ServiceSecureInputMessage arrived =
            JsonSerializer.Deserialize<ServiceSecureInputMessage>(second, WolfIpc.Json)!;

        _output.WriteLine(second);

        // The far end deserialises this into the same DTO the browser's bytes produced. A
        // field renamed or dropped in the middle would be an event silently not injected.
        Assert.Equal(StreamId, arrived.Batch.GetProperty("streamId").GetString());
        Assert.Equal(12, arrived.Batch.GetProperty("sequence").GetInt64());
        Assert.Equal(
            HarmlessKey,
            arrived.Batch.GetProperty("events")[0].GetProperty("key").GetInt32());

        // And it is still a batch the injecting end will accept, which is the only thing the
        // round trip is for.
        SecureInputSink sink = Sink(NullLoggerFactory.Instance);
        using var hook = new KeyboardHook();
        hook.Run(() => sink.Inject(arrived.StreamId, arrived.Batch));

        Assert.Contains(hook.Events, e => e.VirtualKey == HarmlessKey && e.Injected);
    }

    [Fact]
    public void Every_secure_input_message_names_itself()
    {
        // Both ends dispatch on `kind`. A message whose kind did not serialise would be
        // dropped by the far end rather than failing, and the lock screen would simply not
        // respond to the keyboard.
        using JsonDocument document = JsonDocument.Parse("{}");
        JsonElement empty = document.RootElement;

        Assert.Equal(
            "host.secure-input",
            JsonSerializer.Deserialize<HostSecureInputMessage>(
                JsonSerializer.Serialize(new HostSecureInputMessage(StreamId, empty), WolfIpc.Json),
                WolfIpc.Json)!.Kind);

        Assert.Equal(
            "service.secure-input",
            JsonSerializer.Deserialize<ServiceSecureInputMessage>(
                JsonSerializer.Serialize(new ServiceSecureInputMessage(StreamId, empty), WolfIpc.Json),
                WolfIpc.Json)!.Kind);
    }

    [Fact]
    public async Task Input_for_a_host_that_is_not_there_is_dropped_rather_than_delivered()
    {
        await using var supervisor = new SecureDesktopSupervisor(
            NullLogger<SecureDesktopSupervisor>.Instance,
            Path.Combine(AppContext.BaseDirectory, "Wolf.Agent.SessionHost.exe"));

        bool delivered = await supervisor.SendInputAsync(
            new ServiceSecureInputMessage(StreamId, KeyBatch()),
            CancellationToken.None);

        // The ordinary case the instant a screen unlocks: input already in flight arrives
        // after the desktop it was meant for has gone. Saying so beats injecting it
        // somewhere else.
        Assert.False(delivered);
    }

    /* --------------------------------------------------------------------- */
    /* What is not tested here, and why                                       */
    /*                                                                        */
    /* The middle hop, end to end. SecureDesktopWatcher drops forwarded input  */
    /* whenever the client is not currently being shown the secure desktop —   */
    /* input aimed at a lock screen that has just gone would otherwise land on */
    /* the operator's own desktop, typing a password into whatever has focus.  */
    /* That decision is driven by an event only the supervisor can raise, on a */
    /* path that needs the agent running as a service with the screen locked,  */
    /* so it belongs with the gated test in SecureDesktopTests rather than     */
    /* here. Until somebody runs that, this hop is unverified and said to be.  */
    /* --------------------------------------------------------------------- */

    /// <summary>
    /// Keeps every line a component logged, so a test can assert what is <em>not</em> in it.
    ///
    /// Enabled at every level on purpose: a recorder that filtered Debug out would pass the
    /// "no password in the log" test by never seeing the line that carries the events.
    /// </summary>
    private sealed class RecordingLoggerFactory : ILoggerFactory
    {
        private readonly ConcurrentQueue<string> _messages = new();

        public IReadOnlyCollection<string> Messages => _messages;

        public ILogger CreateLogger(string categoryName) => new Recorder(_messages, categoryName);

        public ILogger<T> CreateLogger<T>() => new Recorder<T>(_messages);

        public void AddProvider(ILoggerProvider provider)
        {
            // Nothing to add: this factory records to exactly one place by design.
        }

        public void Dispose()
        {
        }

        private class Recorder : ILogger
        {
            private readonly ConcurrentQueue<string> _messages;
            private readonly string _category;

            public Recorder(ConcurrentQueue<string> messages, string category)
            {
                _messages = messages;
                _category = category;
            }

            public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

            public bool IsEnabled(LogLevel logLevel) => true;

            public void Log<TState>(
                LogLevel logLevel,
                EventId eventId,
                TState state,
                Exception? exception,
                Func<TState, Exception?, string> formatter) =>
                _messages.Enqueue($"[{logLevel}] {_category}: {formatter(state, exception)}");
        }

        private sealed class Recorder<T> : Recorder, ILogger<T>
        {
            public Recorder(ConcurrentQueue<string> messages)
                : base(messages, typeof(T).Name)
            {
            }
        }
    }
}
