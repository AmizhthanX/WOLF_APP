using System.Globalization;
using System.Net;
using System.Net.Sockets;

namespace Wolf.Agent.Core.Power;

/// <summary>One local network a wake packet goes out on: the address it is sent from, and the network's broadcast address.</summary>
public sealed record WakeNetwork(IPAddress Local, IPAddress Broadcast);

/// <summary>
/// The fixed shape of a wake packet, and where one may go.
///
/// A magic packet is six 0xFF bytes and then the target's hardware address sixteen times, sent by UDP to
/// port 9. Nothing about it is chosen by whoever asked for the wake except which of their own PCs it is
/// for — and even that address is the one the sleeping PC reported, filled in by the cloud. So the only
/// thing bounded here is the destination: the broadcast address of a network this PC is itself on.
/// Never a unicast address, never a routed network, never a port other than 9.
/// </summary>
public static class WakeOnLan
{
    public const int Port = 9;
    public const int PacketLength = 6 + (16 * 6);

    /// <summary>
    /// Parse an address in WOLF's form — six lowercase hex pairs joined by colons — refusing a group
    /// address (every machine listening for it, not one) and the all-zero address (no machine).
    /// </summary>
    public static bool TryParseMac(string? text, out byte[] mac)
    {
        mac = Array.Empty<byte>();
        if (text is null || text.Length != 17) return false;

        var bytes = new byte[6];
        for (int i = 0; i < 6; i++)
        {
            int at = i * 3;
            if (i > 0 && text[at - 1] != ':') return false;
            string pair = text.Substring(at, 2);
            if (pair.Any(c => !(char.IsAsciiDigit(c) || c is >= 'a' and <= 'f'))) return false;
            bytes[i] = byte.Parse(pair, NumberStyles.HexNumber, CultureInfo.InvariantCulture);
        }

        if ((bytes[0] & 1) != 0 || bytes.All(b => b == 0)) return false;
        mac = bytes;
        return true;
    }

    public static string FormatMac(ReadOnlySpan<byte> mac) =>
        string.Join(':', mac.ToArray().Select(b => b.ToString("x2", CultureInfo.InvariantCulture)));

    public static byte[] MagicPacket(ReadOnlySpan<byte> mac)
    {
        if (mac.Length != 6) throw new ArgumentException("A hardware address is six bytes.", nameof(mac));

        var packet = new byte[PacketLength];
        packet.AsSpan(0, 6).Fill(0xFF);
        for (int i = 0; i < 16; i++) mac.CopyTo(packet.AsSpan(6 + (i * 6)));
        return packet;
    }

    /// <summary>
    /// The networks a wake packet may be broadcast on, from this PC's IPv4 addresses and prefix lengths.
    ///
    /// Left out: loopback; link-local (169.254/16), which is a PC that failed to get an address rather than
    /// a network anybody's other PC is on; and /31 and /32, which have no broadcast address to send to.
    /// A network wider than /8 is left out too — that is not a home or office LAN, and broadcasting across
    /// it is not what anybody meant by waking their PC.
    /// </summary>
    public static IReadOnlyList<WakeNetwork> Networks(IEnumerable<(IPAddress Address, int PrefixLength)> addresses)
    {
        var networks = new List<WakeNetwork>();
        foreach ((IPAddress address, int prefix) in addresses)
        {
            if (address.AddressFamily != AddressFamily.InterNetwork) continue;
            if (IPAddress.IsLoopback(address)) continue;

            byte[] bytes = address.GetAddressBytes();
            if (bytes[0] == 169 && bytes[1] == 254) continue;
            if (prefix < 8 || prefix > 30) continue;

            uint host = (uint)((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]);
            uint mask = prefix == 0 ? 0 : uint.MaxValue << (32 - prefix);
            uint broadcast = host | ~mask;
            var broadcastAddress = new IPAddress(new[]
            {
                (byte)(broadcast >> 24), (byte)(broadcast >> 16), (byte)(broadcast >> 8), (byte)broadcast,
            });

            if (networks.Any(n => n.Broadcast.Equals(broadcastAddress))) continue;
            networks.Add(new WakeNetwork(address, broadcastAddress));
        }

        return networks;
    }
}

/// <summary>Sends one wake packet. A seam so tests can see every packet without a network to put them on.</summary>
public interface IWakePacketSender
{
    /// <summary>True when Windows accepted the datagram. A UDP send cannot say more than that.</summary>
    bool Send(IPAddress local, IPAddress destination, int port, byte[] packet);
}

public sealed class UdpWakePacketSender : IWakePacketSender
{
    public bool Send(IPAddress local, IPAddress destination, int port, byte[] packet)
    {
        try
        {
            using var socket = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp)
            {
                EnableBroadcast = true,
            };

            // Bound to the local address, so a network's broadcast leaves on that network's adapter
            // rather than wherever the routing table's default happens to point.
            socket.Bind(new IPEndPoint(local, 0));
            return socket.SendTo(packet, new IPEndPoint(destination, port)) == packet.Length;
        }
        catch (SocketException)
        {
            return false;
        }
    }
}
