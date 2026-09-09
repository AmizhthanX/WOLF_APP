using Wolf.Agent.Core.Cloud;
using Xunit;

namespace Wolf.Agent.Core.Tests;

/// <summary>
/// The rule that a stream request is always answered.
///
/// This exists because of a failure with no symptom: a request forwarded to a session host
/// that was already exiting was written to the pipe successfully, read by nobody, and never
/// answered. The viewer sat on "requesting" indefinitely and no log on either side said
/// anything at all — the agent believed it had delivered the message, and it had.
///
/// So the guarantee is not "the send succeeded" but "something came back, or the client was
/// told why not". These tests drive that rule through the sequences that break it.
/// </summary>
public sealed class PendingStreamRequestTests
{
    private static readonly DateTimeOffset Start = new(2026, 1, 1, 12, 0, 0, TimeSpan.Zero);
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(20);

    [Fact]
    public void A_request_the_host_answers_is_not_reported_as_lost()
    {
        var pending = new PendingStreamRequests();
        pending.Track("stream-1", "session-1", Start);

        Assert.True(pending.Answered("stream-1"));
        Assert.Equal(0, pending.Count);

        // Long past the timeout, and there is nothing to report: the stream is the host's
        // business now, and whatever happens to it next is reported by the host.
        Assert.Empty(pending.TakeExpired(Start + TimeSpan.FromMinutes(5), Timeout));
    }

    [Fact]
    public void A_request_the_host_never_answers_is_reported_once_the_timeout_passes()
    {
        var pending = new PendingStreamRequests();
        pending.Track("stream-1", "session-1", Start);

        // Still within the window. A cold start is genuinely slow — a capture device, an
        // encoder, a pipeline — and giving up early would turn a slow machine into a broken
        // one.
        Assert.Empty(pending.TakeExpired(Start + TimeSpan.FromSeconds(19), Timeout));

        IReadOnlyList<PendingStreamRequest> expired =
            pending.TakeExpired(Start + TimeSpan.FromSeconds(21), Timeout);

        PendingStreamRequest lost = Assert.Single(expired);
        Assert.Equal("stream-1", lost.StreamId);

        // The session id comes back with it: the error has to be addressed to the client
        // that asked, and by this point nothing else remembers who that was.
        Assert.Equal("session-1", lost.SessionId);
    }

    [Fact]
    public void An_expired_request_is_reported_once_and_not_again()
    {
        var pending = new PendingStreamRequests();
        pending.Track("stream-1", "session-1", Start);

        DateTimeOffset later = Start + TimeSpan.FromSeconds(30);

        Assert.Single(pending.TakeExpired(later, Timeout));

        // Taken, not read. Two sweeps would otherwise send a client two errors for one
        // request, and the second would arrive about a stream it had already given up on.
        Assert.Empty(pending.TakeExpired(later, Timeout));
        Assert.Equal(0, pending.Count);
    }

    [Fact]
    public void Losing_the_host_reports_everything_still_waiting()
    {
        var pending = new PendingStreamRequests();
        pending.Track("stream-1", "session-1", Start);
        pending.Track("stream-2", "session-2", Start + TimeSpan.FromSeconds(1));

        // Nothing has timed out yet, and nothing is going to: the host is gone, so waiting
        // out the remaining seconds would only delay telling people what already happened.
        IReadOnlyList<PendingStreamRequest> lost = pending.TakeAll();

        Assert.Equal(2, lost.Count);
        Assert.Contains(lost, request => request.StreamId == "stream-1");
        Assert.Contains(lost, request => request.StreamId == "stream-2");
        Assert.Equal(0, pending.Count);
    }

    [Fact]
    public void A_host_lost_report_and_a_sweep_cannot_both_claim_the_same_request()
    {
        var pending = new PendingStreamRequests();
        pending.Track("stream-1", "session-1", Start);

        // The host dies at the moment a sweep would have expired the request anyway. Both
        // paths run, and exactly one of them may report it.
        Assert.Single(pending.TakeAll());
        Assert.Empty(pending.TakeExpired(Start + TimeSpan.FromMinutes(1), Timeout));
    }

    [Fact]
    public void Re_requesting_the_same_stream_restarts_its_clock()
    {
        var pending = new PendingStreamRequests();
        pending.Track("stream-1", "session-1", Start);
        pending.Track("stream-1", "session-1", Start + TimeSpan.FromSeconds(15));

        // Measured from the newer request, not the first: a client that asked again is
        // waiting on the second attempt, and timing it out against the first would report a
        // failure five seconds into a request that is still perfectly healthy.
        Assert.Empty(pending.TakeExpired(Start + TimeSpan.FromSeconds(30), Timeout));
        Assert.Single(pending.TakeExpired(Start + TimeSpan.FromSeconds(36), Timeout));
    }

    [Fact]
    public void Clearing_reports_nothing()
    {
        var pending = new PendingStreamRequests();
        pending.Track("stream-1", "session-1", Start);

        // Used when the cloud link itself drops. Those clients have already been told the
        // agent disconnected, and a second error about a stream they know is dead is noise.
        pending.Clear();

        Assert.Equal(0, pending.Count);
        Assert.Empty(pending.TakeAll());
    }
}
