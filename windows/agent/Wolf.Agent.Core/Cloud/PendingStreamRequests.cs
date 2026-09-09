using System.Collections.Concurrent;

namespace Wolf.Agent.Core.Cloud;

/// <summary>A stream request handed to the session host that has produced nothing yet.</summary>
public sealed record PendingStreamRequest(string StreamId, string SessionId, DateTimeOffset ForwardedAt);

/// <summary>
/// Stream requests forwarded to the session host and not yet answered.
///
/// The agent has to remember these itself, because a successful send is not evidence of
/// anything: writing to the host's named pipe succeeds for a host that is already exiting —
/// the bytes reach the buffer and nobody ever reads them. Without this, a request that
/// arrived in the gap around a host restart left the viewer showing "requesting" for as long
/// as somebody was willing to watch it, with nothing in any log to say what had happened.
///
/// Kept apart from <see cref="CloudLink"/> and free of I/O so the rule — every request is
/// answered, exactly once — can be tested against sequences of events rather than inferred
/// from a running agent. The clock is a parameter for the same reason: a twenty-second
/// timeout is not something to wait out in a test.
/// </summary>
public sealed class PendingStreamRequests
{
    private readonly ConcurrentDictionary<string, PendingStreamRequest> _pending = new();

    public int Count => _pending.Count;

    /// <summary>
    /// Remember a request that has just been sent to the host.
    ///
    /// Called before the send rather than after: a host that answers immediately must find
    /// the entry already there, or the answer would clear nothing and the request would be
    /// reported as unanswered twenty seconds later.
    /// </summary>
    public void Track(string streamId, string sessionId, DateTimeOffset now) =>
        _pending[streamId] = new PendingStreamRequest(streamId, sessionId, now);

    /// <summary>
    /// Note that the host has said something about this stream.
    ///
    /// Any message at all counts. An offer, an error, a state change — all of them mean the
    /// request arrived and is being acted on, which is the only thing being waited for here.
    /// </summary>
    public bool Answered(string streamId) => _pending.TryRemove(streamId, out _);

    /// <summary>
    /// Take the requests that have gone unanswered for longer than <paramref name="timeout"/>.
    ///
    /// Removed as they are returned, so a caller that reports them cannot report them twice
    /// and two callers cannot both report the same one.
    /// </summary>
    public IReadOnlyList<PendingStreamRequest> TakeExpired(DateTimeOffset now, TimeSpan timeout)
    {
        DateTimeOffset deadline = now - timeout;
        var expired = new List<PendingStreamRequest>();

        foreach (KeyValuePair<string, PendingStreamRequest> entry in _pending)
        {
            if (entry.Value.ForwardedAt > deadline) continue;
            if (_pending.TryRemove(entry.Key, out PendingStreamRequest? taken)) expired.Add(taken);
        }

        return expired;
    }

    /// <summary>
    /// Take everything, for when the host has gone and none of it can be answered.
    ///
    /// Emptied rather than read, so the sweep that runs afterwards does not report the same
    /// requests a second time.
    /// </summary>
    public IReadOnlyList<PendingStreamRequest> TakeAll()
    {
        var taken = new List<PendingStreamRequest>();

        foreach (string streamId in _pending.Keys)
        {
            if (_pending.TryRemove(streamId, out PendingStreamRequest? entry)) taken.Add(entry);
        }

        return taken;
    }

    /// <summary>Forget everything without reporting it, for a link that is going down anyway.</summary>
    public void Clear() => _pending.Clear();
}
