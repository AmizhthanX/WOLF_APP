using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Wolf.Agent.Core.Ipc;
using Wolf.Agent.SessionHost.Input;
using Xunit;
using Xunit.Abstractions;

namespace Wolf.Agent.Core.Tests;

/// <summary>
/// The gate on remote control.
///
/// Input is the one path in WOLF where the cloud is not in the middle: events go straight
/// from the browser to the session host over the WebRTC data channel. Nothing upstream has
/// looked at these bytes, so everything that stands between a stranger's keystroke and
/// somebody's keyboard is in this class. These tests are about that boundary, not about
/// whether SendInput works — <see cref="InputInjectionTests"/> covers that separately.
///
/// Where an event is expected to be injected, it is injected for real and swallowed by a
/// low-level hook, so the tests prove acceptance rather than merely the absence of a
/// rejection.
/// </summary>
[Collection("Capture")]
public sealed class InputChannelTests
{
    private readonly ITestOutputHelper _output;

    public InputChannelTests(ITestOutputHelper output)
    {
        _output = output;
    }

    private const string StreamId = "01J9ZQK7T0000000000000000B";
    private const string SessionId = "01J9ZQK7T0000000000000000A";

    /// <summary>F24: a key that exists in the virtual-key table and on almost no keyboard.</summary>
    private const int HarmlessKey = 0x87;

    private static InputChannel Channel() => new(
        StreamId,
        new InputInjector(
            new IpcDisplay("\\\\.\\DISPLAY1", "Test", 1920, 1080, 60, true, 1, false, 0, 0),
            NullLogger<InputInjector>.Instance),
        NullLogger<InputChannel>.Instance);

    /// <summary>
    /// A batch as the control channel hands it over: already separated from the message that
    /// carried it, so what these tests exercise is the input checking itself.
    /// </summary>
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

    private static void Grant(InputChannel channel, int secondsFromNow = 120) =>
        channel.ApplyControl(true, SessionId, DateTimeOffset.UtcNow.AddSeconds(secondsFromNow));

    /* --------------------------------------------------------------------- */
    /* The gate                                                              */
    /* --------------------------------------------------------------------- */

    [Fact]
    public void Input_is_refused_until_the_cloud_says_who_is_driving()
    {
        InputChannel channel = Channel();

        InputRejection? rejection = channel.Handle(KeyBatch());

        _output.WriteLine(rejection?.Reason);

        // The default is no. A session that was never granted control must not be able to
        // type on somebody's machine by being first to open a data channel.
        Assert.NotNull(rejection);
        Assert.Equal("not-permitted", rejection!.Outcome);
        Assert.False(channel.HasControl);
        Assert.Equal(0, channel.EventsInjected);
    }

    [Fact]
    public void Input_is_accepted_once_control_has_been_granted()
    {
        InputChannel channel = Channel();
        Grant(channel);

        using var hook = new KeyboardHook();
        InputRejection? rejection = null;
        hook.Run(() => rejection = channel.Handle(KeyBatch()));

        _output.WriteLine($"observed {hook.Events.Count} key events; rejection: {rejection?.Reason ?? "none"}");

        // No response at all is the healthy case: acknowledging every batch would double
        // the message rate for no benefit.
        Assert.Null(rejection);
        Assert.Equal(1, channel.EventsInjected);
        Assert.Contains(hook.Events, e => e.VirtualKey == HarmlessKey && e.Injected);
    }

    [Fact]
    public void Input_stops_when_the_lease_expires_even_if_nothing_says_so()
    {
        InputChannel channel = Channel();

        // A lease that lapsed a second ago. Nothing arrived to revoke it — this is the case
        // where the cloud became unreachable, and it is the reason the expiry is enforced
        // here rather than only in the relay.
        channel.ApplyControl(true, SessionId, DateTimeOffset.UtcNow.AddSeconds(-1));

        Assert.False(channel.HasControl);

        InputRejection? rejection = channel.Handle(KeyBatch());
        _output.WriteLine(rejection?.Reason);

        Assert.NotNull(rejection);
        Assert.Equal("not-permitted", rejection!.Outcome);
        Assert.Contains("expired", rejection.Reason, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(0, channel.EventsInjected);
    }

    [Fact]
    public void Revoking_control_stops_input_immediately()
    {
        InputChannel channel = Channel();
        Grant(channel);

        using (var hook = new KeyboardHook())
        {
            hook.Run(() => channel.Handle(KeyBatch(sequence: 0)));
        }

        Assert.Equal(1, channel.EventsInjected);

        channel.ApplyControl(granted: false, null, null);

        Assert.False(channel.HasControl);
        Assert.NotNull(channel.Handle(KeyBatch(sequence: 1)));
        Assert.Equal(1, channel.EventsInjected);
    }

    [Fact]
    public void Losing_control_releases_whatever_was_being_held_down()
    {
        InputChannel channel = Channel();
        Grant(channel);

        using var hook = new KeyboardHook();
        hook.Run(() => channel.ApplyControl(granted: false, null, null));

        int[] modifiers = { 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0x5B, 0x5C };

        _output.WriteLine($"released: {string.Join(", ", hook.Events.Select(e => e.VirtualKey))}");

        // A client that loses the lease mid-chord would otherwise leave the machine with a
        // stuck Ctrl, and the person sitting at it finds every keystroke becoming a shortcut.
        foreach (int modifier in modifiers)
        {
            Assert.Contains(hook.Events, e => e.VirtualKey == modifier && e.IsUp);
        }
    }

    [Fact]
    public void A_stream_that_never_had_control_releases_nothing_on_teardown()
    {
        InputChannel channel = Channel();

        using var hook = new KeyboardHook();
        hook.Run(() => channel.Relinquish());

        // Sending key-ups for a session that never held control would inject input on
        // behalf of somebody who was never allowed to.
        Assert.Empty(hook.Events);
    }

    /* --------------------------------------------------------------------- */
    /* Validation, because nothing upstream did it                            */
    /* --------------------------------------------------------------------- */

    [Fact]
    public void A_batch_for_another_stream_is_refused()
    {
        InputChannel channel = Channel();
        Grant(channel);

        InputRejection? rejection = channel.Handle(
            KeyBatch(streamId: "01J9ZQK7T0000000000000000Z"));

        Assert.NotNull(rejection);
        Assert.Equal("rejected", rejection!.Outcome);
        Assert.Equal(0, channel.EventsInjected);
    }

    [Theory]
    [InlineData("""[{"type":"pointer.move","x":4,"y":0.5,"offsetMs":0}]""", "a coordinate outside 0..1")]
    [InlineData("""[{"type":"pointer.move","x":-1,"y":0.5,"offsetMs":0}]""", "a negative coordinate")]
    [InlineData("""[{"type":"key","key":0,"action":"down","extended":false,"offsetMs":0}]""", "virtual key 0")]
    [InlineData("""[{"type":"key","key":900,"action":"down","extended":false,"offsetMs":0}]""", "a key above 254")]
    [InlineData("""[{"type":"pointer.scroll","x":0.5,"y":0.5,"deltaX":0,"deltaY":9000,"offsetMs":0}]""", "an unbounded scroll")]
    [InlineData("""[{"type":"pointer.button","x":0.5,"y":0.5,"button":"thumb","action":"down","offsetMs":0}]""", "an invented button")]
    [InlineData("""[{"type":"exec","value":"whoami","offsetMs":0}]""", "an event type that does not exist")]
    public void An_event_outside_its_bounds_is_refused_rather_than_clamped_into_something(
        string events,
        string description)
    {
        InputChannel channel = Channel();
        Grant(channel);

        InputRejection? rejection = channel.Handle(Batch(StreamId, 0, events));

        _output.WriteLine($"{description}: {rejection?.Reason ?? "ACCEPTED"}");

        // The protocol bounds these, and the cloud validates the signaling path — but input
        // does not travel that path, so this is the only check there is.
        Assert.NotNull(rejection);
        Assert.Equal(0, channel.EventsInjected);
    }

    [Fact]
    public void A_batch_larger_than_the_protocol_allows_is_refused_whole()
    {
        InputChannel channel = Channel();
        Grant(channel);

        string events = "[" + string.Join(
            ",",
            Enumerable.Repeat("""{"type":"pointer.move","x":0.5,"y":0.5,"offsetMs":0}""", 200)) + "]";

        InputRejection? rejection = channel.Handle(Batch(StreamId, 0, events));

        _output.WriteLine(rejection?.Reason);

        // Refused as a batch rather than truncated: injecting the first 128 of 200 events
        // would deliver half of whatever the sender was doing.
        Assert.NotNull(rejection);
        Assert.Equal("rejected", rejection!.Outcome);
        Assert.Equal(0, channel.EventsInjected);
    }

    [Fact]
    public void Malformed_bytes_produce_a_refusal_rather_than_a_crash()
    {
        InputChannel channel = Channel();
        Grant(channel);

        // A batch with nothing in it, and one whose events are the wrong shape entirely.
        Assert.NotNull(channel.Handle(JsonDocument.Parse("""{"streamId":"x","sequence":1}""").RootElement));
        Assert.NotNull(channel.Handle(JsonDocument.Parse("{}").RootElement));
        Assert.NotNull(channel.Handle(Batch(StreamId, 1, "[]")));

        Assert.Equal(0, channel.EventsInjected);
    }

    [Fact]
    public void A_combination_Windows_reserves_is_reported_as_a_limitation_not_a_rejection()
    {
        InputChannel channel = Channel();
        Grant(channel);

        InputRejection? rejection = channel.Handle(
            Batch(StreamId, 0, """[{"type":"system.combo","combo":"ctrl-alt-del","offsetMs":0}]"""));

        _output.WriteLine(rejection?.Reason);

        // The distinction matters to the operator: "WOLF refused this" and "Windows does
        // not allow this" call for different responses.
        Assert.NotNull(rejection);
        Assert.Equal("unsupported", rejection!.Outcome);
        Assert.True(rejection.Limitation);
    }

    [Fact]
    public void A_refusal_names_the_batch_it_refers_to()
    {
        InputChannel channel = Channel();
        Grant(channel);

        InputRejection? rejection = channel.Handle(
            Batch(StreamId, 41, """[{"type":"key","key":0,"action":"down","extended":false,"offsetMs":0}]"""));

        Assert.NotNull(rejection);
        Assert.Equal(41, rejection!.Sequence);
        Assert.Equal(StreamId, rejection.StreamId);

        // The response goes back over the data channel and has to survive the round trip
        // as the protocol's `inputResponse` shape.
        string json = JsonSerializer.Serialize(rejection, WolfIpc.Json);
        _output.WriteLine(json);

        using JsonDocument parsed = JsonDocument.Parse(json);
        Assert.Equal(41, parsed.RootElement.GetProperty("sequence").GetInt64());
        Assert.Equal("rejected", parsed.RootElement.GetProperty("outcome").GetString());
        Assert.False(parsed.RootElement.GetProperty("limitation").GetBoolean());
    }
}
