using System.Net;

namespace Wolf.Agent.Core.Diagnostics;

/// <summary>What the policy decided about a probe, and why.</summary>
public sealed record ProbeVerdict(bool Ok, string Reason, int Count, int TimeoutMs, int Port);

/// <summary>
/// What WOLF will and will not probe on the operator's behalf.
///
/// A network test is not a read. It is WOLF asking somebody else's machine to send packets to
/// a destination the operator chose — small when the destination is the office gateway, and a
/// different thing entirely when it is a host they have no business touching.
///
/// **WOLF does not decide which of those it is, because it cannot.** "Can this PC reach the
/// file server" and "can this PC reach the internet" are the two most common diagnostics
/// there are, and a rule that refused private ranges or public ones would break one of them.
/// A rule that tried to tell a legitimate target from an illegitimate one would be guessing
/// about somebody else's network.
///
/// So what is bounded is the **shape**, not the destination:
///
///  - one host per command, never a range or a list;
///  - a handful of packets, not a flood;
///  - one port, never a range — a port range is a port scan with a different name;
///  - a short timeout, so a command cannot hold a probe open indefinitely.
///
/// And every test is audited with its target recorded. That is what makes the difference
/// between a diagnostic tool and a scanner *accountable* rather than merely asserted: the
/// bounds stop a sweep, and the trail catches somebody trying to build one out of many
/// commands.
///
/// The one thing refused outright is the set of addresses that turn a single probe into many.
/// Broadcast and multicast reach every listener on a segment, which is a sweep whatever it was
/// meant to be.
/// </summary>
public static class ProbePolicy
{
    /// <summary>Echo requests per test. What `ping` sends by default, and plenty to decide.</summary>
    public const int MaxCount = 4;

    /// <summary>Milliseconds one probe waits: long enough for a slow link, short enough to answer.</summary>
    public const int MaxTimeoutMs = 5000;

    /// <summary>Below this a timeout measures the local stack rather than the network.</summary>
    public const int MinTimeoutMs = 100;

    /// <summary>
    /// Whether this probe may run, and with what bounds.
    ///
    /// Values above the caps are clamped rather than refused. A client asking for twenty pings
    /// is not attacking anything — it is a client that has not read the protocol — and giving
    /// it four is more useful than giving it an error.
    /// </summary>
    public static ProbeVerdict Check(string test, string? target, int count, int timeoutMs, int port)
    {
        if (string.IsNullOrWhiteSpace(target))
        {
            return new ProbeVerdict(false, "No host was named.", 0, 0, 0);
        }

        string trimmed = target.Trim();

        if (trimmed.Length > 253)
        {
            return new ProbeVerdict(false, "That host name is longer than a host name can be.", 0, 0, 0);
        }

        // A slash is a range, a comma is a list. Both turn one command into a sweep, and both
        // are refused here rather than being silently interpreted as a literal host name that
        // then fails to resolve for a reason nobody can read.
        if (trimmed.Contains('/', StringComparison.Ordinal) ||
            trimmed.Contains(',', StringComparison.Ordinal) ||
            trimmed.Contains(' ', StringComparison.Ordinal))
        {
            return new ProbeVerdict(
                false,
                "WOLF tests one host at a time. Ranges and lists are not accepted.",
                0, 0, 0);
        }

        if (!IsProbeable(trimmed, out string? why))
        {
            return new ProbeVerdict(false, why!, 0, 0, 0);
        }

        int boundedCount = test == "ping" ? Math.Clamp(count, 1, MaxCount) : 1;
        int boundedTimeout = Math.Clamp(timeoutMs, MinTimeoutMs, MaxTimeoutMs);

        if (test == "tcp")
        {
            if (port is < 1 or > 65535)
            {
                return new ProbeVerdict(false, "A TCP test needs one port between 1 and 65535.", 0, 0, 0);
            }

            return new ProbeVerdict(true, string.Empty, 1, boundedTimeout, port);
        }

        if (test is not ("ping" or "dns"))
        {
            return new ProbeVerdict(false, $"'{test}' is not a network test WOLF runs.", 0, 0, 0);
        }

        return new ProbeVerdict(true, string.Empty, boundedCount, boundedTimeout, 0);
    }

    /// <summary>
    /// Whether an address is one probe rather than many.
    ///
    /// Broadcast and multicast are refused because one packet to either reaches every listener
    /// on a segment. Everything else is allowed, including loopback — "is the stack working at
    /// all" is a real question and the answer is genuinely useful.
    /// </summary>
    public static bool IsProbeable(string target, out string? why)
    {
        why = null;

        if (string.Equals(target, "255.255.255.255", StringComparison.Ordinal) ||
            string.Equals(target, "0.0.0.0", StringComparison.Ordinal))
        {
            why = "That is a broadcast address. WOLF tests one host at a time.";
            return false;
        }

        if (!IPAddress.TryParse(target, out IPAddress? address))
        {
            // A name. It could resolve to a multicast address, and that is checked after
            // resolution rather than guessed at here — a name is not a shape.
            return true;
        }

        if (address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
        {
            byte[] octets = address.GetAddressBytes();

            // 224.0.0.0/4.
            if (octets[0] is >= 224 and <= 239)
            {
                why = "That is a multicast address, which reaches every listener on the segment.";
                return false;
            }

            // WOLF cannot know the subnet mask from here, so the common case is treated as
            // what it usually is: the broadcast address of an ordinary /24.
            if (octets[3] == 255)
            {
                why = "That looks like a broadcast address. WOLF tests one host at a time.";
                return false;
            }
        }

        if (address.IsIPv6Multicast)
        {
            why = "That is a multicast address, which reaches every listener on the segment.";
            return false;
        }

        return true;
    }

    /// <summary>
    /// Whether an address a *name* resolved to is one WOLF will probe.
    ///
    /// Checked separately because a name is not a shape: `all-hosts.example` resolving to a
    /// multicast group is the case that gets past the syntactic check, and it is exactly the
    /// case that matters.
    /// </summary>
    public static bool IsProbeableAddress(IPAddress address) =>
        IsProbeable(address.ToString(), out _);
}
