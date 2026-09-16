using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Runtime.Versioning;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Wolf.Agent.Core.Power;
using Wolf.Agent.Core.Protocol;

namespace Wolf.Agent.Core.Commands;

/// <summary>
/// Wake another PC on the same local network.
///
/// This PC is awake; the one being woken is not, and cannot hear a command. So this PC broadcasts a magic
/// packet on each network it is on and reports how many it sent — never that the other PC woke, which a
/// UDP broadcast cannot know. The cloud sees it wake when its agent connects.
///
/// The packet is sent three times, a fifth of a second apart, on each network: to the network's broadcast
/// address and to 255.255.255.255 from that network's address. Some adapters miss the first packet as
/// they settle into sleep; some switches forward one kind of broadcast and not the other.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class WakeCommandHandler : ICommandHandler
{
    private const int Rounds = 3;
    private static readonly TimeSpan BetweenRounds = TimeSpan.FromMilliseconds(200);

    private readonly IWakePacketSender _sender;
    private readonly Func<IReadOnlyList<WakeNetwork>> _networks;
    private readonly Func<IReadOnlySet<string>> _ownAddresses;
    private readonly int _port;
    private readonly ILogger<WakeCommandHandler> _logger;

    public WakeCommandHandler(ILogger<WakeCommandHandler> logger)
        : this(new UdpWakePacketSender(), LocalNetworks, WakeAdapter.OwnAddresses, WakeOnLan.Port, logger)
    {
    }

    public WakeCommandHandler(
        IWakePacketSender sender,
        Func<IReadOnlyList<WakeNetwork>> networks,
        Func<IReadOnlySet<string>> ownAddresses,
        int port,
        ILogger<WakeCommandHandler> logger)
    {
        _sender = sender;
        _networks = networks;
        _ownAddresses = ownAddresses;
        _port = port;
        _logger = logger;
    }

    public IReadOnlyList<string> SupportedTypes { get; } = new[] { "power.wake" };

    public async Task<CommandExecution> ExecuteAsync(CommandEnvelope envelope, CancellationToken cancellationToken)
    {
        JsonElement payload = envelope.Payload;
        string targetPcId = payload.TryGetProperty("targetPcId", out JsonElement target) ? target.GetString() ?? string.Empty : string.Empty;
        string? macText = payload.TryGetProperty("macAddress", out JsonElement mac) ? mac.GetString() : null;

        if (!WakeOnLan.TryParseMac(macText, out byte[] address))
        {
            return CommandExecution.Failed(
                "invalid-payload",
                "The wake did not carry a single adapter's address, so no packet was sent.",
                "Update WOLF on the cloud side; it fills in the address.");
        }

        if (_ownAddresses().Contains(WakeOnLan.FormatMac(address)))
        {
            return CommandExecution.Failed("wake-self", "That address is one of this PC's own adapters. A PC cannot wake itself.");
        }

        IReadOnlyList<WakeNetwork> networks = _networks();
        if (networks.Count == 0)
        {
            return CommandExecution.Limitation(
                "no-local-network",
                "This PC is not on a local network it could send a wake packet across.",
                "Wake it from a PC connected to the same network as the one asleep.");
        }

        byte[] packet = WakeOnLan.MagicPacket(address);
        var limitedBroadcast = IPAddress.Broadcast;
        int sent = 0;

        for (int round = 0; round < Rounds; round++)
        {
            if (round > 0) await Task.Delay(BetweenRounds, cancellationToken).ConfigureAwait(false);
            foreach (WakeNetwork network in networks)
            {
                if (_sender.Send(network.Local, network.Broadcast, _port, packet)) sent++;
                if (_sender.Send(network.Local, limitedBroadcast, _port, packet)) sent++;
            }
        }

        if (sent == 0)
        {
            return CommandExecution.Failed(
                "wake-send-failed",
                "Windows did not send any of the wake packets. A firewall on this PC may be blocking outbound broadcasts.",
                "Check this PC's firewall, or wake the other PC from a different one.");
        }

        // No address in the log: which machine was woken is in the audit record, by PC id.
        _logger.LogInformation("Sent {Sent} wake packet(s) across {Networks} local network(s).", sent, networks.Count);

        return CommandExecution.Success(new
        {
            targetPcId,
            method = "lan-broadcast",
            packetsSent = sent,
            networks = networks.Count,
            sentAt = DateTimeOffset.UtcNow.ToString("O", System.Globalization.CultureInfo.InvariantCulture),
            // A broadcast cannot know whether anything heard it. The PC waking is seen when it connects.
            confirmationPending = true,
        });
    }

    /// <summary>This PC's IPv4 networks on adapters that are up, excluding loopback and tunnels.</summary>
    public static IReadOnlyList<WakeNetwork> LocalNetworks() =>
        WakeOnLan.Networks(
            NetworkInterface.GetAllNetworkInterfaces()
                .Where(adapter => adapter.OperationalStatus == OperationalStatus.Up)
                .Where(adapter => adapter.NetworkInterfaceType is not (NetworkInterfaceType.Loopback or NetworkInterfaceType.Tunnel))
                .SelectMany(adapter => adapter.GetIPProperties().UnicastAddresses)
                .Where(unicast => unicast.Address.AddressFamily == AddressFamily.InterNetwork)
                .Select(unicast => (unicast.Address, unicast.PrefixLength)));
}
