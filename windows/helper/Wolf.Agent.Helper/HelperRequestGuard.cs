using Wolf.Agent.Core.Privileged;

namespace Wolf.Agent.Helper;

/// <summary>Why a request was refused, or null when it was not.</summary>
public sealed record HelperRefusal(string Code, string Message);

/// <summary>
/// Decides whether one request may be performed, before anything privileged happens.
///
/// Kept apart from the pipe, and free of I/O, for the same reason the adaptation controller
/// is kept apart from the stream: this is the part with the security property, and it should
/// be checkable against sequences of requests rather than only by connecting to a running
/// service. That matters more than usual here, because the pipe itself is locked to SYSTEM
/// and Administrators — so on an ordinary developer machine the channel cannot be opened at
/// all, and logic that lived inside it could only be tested by an elevated run that most
/// people will never do.
///
/// One guard belongs to one connection. The nonce is the connection's, and the sequence is
/// counted within it.
/// </summary>
public sealed class HelperRequestGuard
{
    private readonly string _nonce;
    private long _lastSequence;

    public HelperRequestGuard(string nonce)
    {
        _nonce = nonce;
    }

    /// <summary>The highest sequence number accepted so far on this connection.</summary>
    public long LastSequence => _lastSequence;

    /// <summary>
    /// Check one request. Returns the refusal, or null when it may proceed.
    ///
    /// Order matters: shape, then version, then freshness, then the allow-list. A request
    /// that fails an earlier check is not examined by a later one, so a malformed message
    /// cannot reach the operation lookup, and a replayed one is refused whatever it asks
    /// for.
    /// </summary>
    public HelperRefusal? Check(string? kind, int version, string? nonce, long sequence, string? operation)
    {
        if (kind != HelperRequestMessage.KindName)
        {
            return new HelperRefusal("malformed", "That is not a helper request.");
        }

        if (version != HelperProtocol.Version)
        {
            return new HelperRefusal(
                "version-mismatch",
                "This helper speaks a different protocol version.");
        }

        // Constant-time, because the nonce is the one value an attacker would be guessing.
        if (!FixedTimeEquals(nonce, _nonce))
        {
            return new HelperRefusal("bad-nonce", "That request was not issued for this connection.");
        }

        if (sequence <= _lastSequence)
        {
            // Either a replay or a bug. Both are refused: on a channel between two WOLF
            // processes neither should ever happen.
            return new HelperRefusal("replayed", "That request has already been seen.");
        }

        if (operation is null || !HelperProtocol.IsAllowed(operation))
        {
            // The allow-list is the point of this whole process. Refused by name, so the log
            // says what was asked for rather than that something was.
            return new HelperRefusal("not-allowed", $"This helper does not perform '{operation}'.");
        }

        // Advanced only once the request is going to be performed. A refused request must
        // not consume a sequence number, or a caller could be talked out of its own channel
        // by anything that got a malformed message in first.
        _lastSequence = sequence;
        return null;
    }

    private static bool FixedTimeEquals(string? candidate, string expected)
    {
        byte[] left = System.Text.Encoding.UTF8.GetBytes(candidate ?? string.Empty);
        byte[] right = System.Text.Encoding.UTF8.GetBytes(expected);
        return System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(left, right);
    }
}
