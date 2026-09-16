using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Wolf.Agent.Core.Commands;
using Wolf.Agent.Core.Power;
using Wolf.Agent.Core.Protocol;
using Xunit;
using Xunit.Abstractions;

namespace Wolf.Agent.Core.Tests;

/// <summary>
/// Waking another PC: a packet of a fixed shape, to broadcast addresses of networks this PC is on, for an
/// address the cloud filled in — and a result that never claims the other PC woke.
/// </summary>
public sealed class WakeOnLanTests
{
    private const string Target = "d8:bb:c1:0a:2b:3c";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly ITestOutputHelper _output;

    public WakeOnLanTests(ITestOutputHelper output)
    {
        _output = output;
    }

    private sealed class RecordingSender : IWakePacketSender
    {
        public List<(IPAddress Local, IPAddress Destination, int Port, byte[] Packet)> Sent { get; } = new();
        public bool Accept { get; init; } = true;

        public bool Send(IPAddress local, IPAddress destination, int port, byte[] packet)
        {
            Sent.Add((local, destination, port, packet));
            return Accept;
        }
    }

    private static readonly WakeNetwork HomeLan = new(IPAddress.Parse("192.168.1.20"), IPAddress.Parse("192.168.1.255"));

    private static WakeCommandHandler Handler(
        IWakePacketSender sender,
        IReadOnlyList<WakeNetwork>? networks = null,
        IReadOnlySet<string>? own = null) =>
        new(sender, () => networks ?? new[] { HomeLan }, () => own ?? new HashSet<string>(), WakeOnLan.Port, NullLogger<WakeCommandHandler>.Instance);

    private static Task<CommandExecution> Wake(WakeCommandHandler handler, object payload) =>
        handler.ExecuteAsync(
            new CommandEnvelope(
                CommandId: "01J9ZQK7T0000000000000000C",
                PcId: "01J9ZQK7T0000000000000000P",
                RequestId: "01J9ZQK7T0000000000000000Q",
                IssuedAt: DateTimeOffset.UtcNow,
                ExpiresAt: DateTimeOffset.UtcNow.AddMinutes(1),
                IdempotencyKey: "01J9ZQK7T0000000000000000I",
                Type: "power.wake",
                Payload: JsonSerializer.SerializeToElement(payload, Json),
                Authorization: default),
            CancellationToken.None);

    [Fact]
    public void A_magic_packet_is_six_ff_bytes_then_the_address_sixteen_times()
    {
        Assert.True(WakeOnLan.TryParseMac(Target, out byte[] mac));
        byte[] packet = WakeOnLan.MagicPacket(mac);

        Assert.Equal(102, packet.Length);
        Assert.All(packet[..6], b => Assert.Equal(0xFF, b));
        for (int i = 0; i < 16; i++) Assert.Equal(mac, packet[(6 + (i * 6))..(12 + (i * 6))]);
    }

    [Theory]
    [InlineData("D8:BB:C1:0A:2B:3C")]
    [InlineData("d8-bb-c1-0a-2b-3c")]
    [InlineData("d8bbc10a2b3c")]
    [InlineData("01:00:5e:00:00:01")]
    [InlineData("ff:ff:ff:ff:ff:ff")]
    [InlineData("00:00:00:00:00:00")]
    [InlineData("d8:bb:c1:0a:2b:3g")]
    [InlineData(null)]
    public void Only_one_adapters_address_in_WOLFs_form_is_accepted(string? text)
    {
        Assert.False(WakeOnLan.TryParseMac(text, out _));
    }

    [Fact]
    public void A_permanent_address_from_Windows_is_put_in_WOLFs_form_and_a_group_address_is_not()
    {
        Assert.Equal(Target, WakeAdapter.FromPermanentAddress("D8BBC10A2B3C"));
        Assert.Null(WakeAdapter.FromPermanentAddress("FFFFFFFFFFFF"));
        Assert.Null(WakeAdapter.FromPermanentAddress("D8BBC10A2B"));
        Assert.Null(WakeAdapter.FromPermanentAddress(null));
    }

    [Fact]
    public void Networks_are_the_broadcast_addresses_of_this_PCs_own_LANs_and_nothing_wider_or_narrower()
    {
        IReadOnlyList<WakeNetwork> networks = WakeOnLan.Networks(new[]
        {
            (IPAddress.Parse("192.168.1.20"), 24),
            (IPAddress.Parse("10.4.7.9"), 22),
            (IPAddress.Parse("192.168.1.21"), 24),      // a second address on the same LAN: one network
            (IPAddress.Parse("127.0.0.1"), 8),          // loopback
            (IPAddress.Parse("169.254.10.2"), 16),      // no DHCP answer: not a network another PC is on
            (IPAddress.Parse("100.64.0.2"), 32),        // a VPN host route: no broadcast address
            (IPAddress.Parse("172.20.0.2"), 31),
            (IPAddress.Parse("11.0.0.1"), 7),           // wider than any LAN
            (IPAddress.Parse("fe80::1"), 64),           // IPv6 has no broadcast
        });

        Assert.Equal(
            new[] { ("192.168.1.20", "192.168.1.255"), ("10.4.7.9", "10.4.7.255") },
            networks.Select(n => (n.Local.ToString(), n.Broadcast.ToString())));
    }

    [Fact]
    public async Task A_wake_broadcasts_the_packet_three_times_on_each_network_and_never_claims_it_worked()
    {
        var sender = new RecordingSender();
        var second = new WakeNetwork(IPAddress.Parse("10.4.7.9"), IPAddress.Parse("10.4.7.255"));

        CommandExecution execution = await Wake(Handler(sender, new[] { HomeLan, second }), new { targetPcId = "01J9ZQK7T0000000000000000A", macAddress = Target });

        Assert.Null(execution.Failure);
        Assert.Equal(12, sender.Sent.Count);
        Assert.All(sender.Sent, packet =>
        {
            Assert.Equal(9, packet.Port);
            Assert.True(packet.Destination.Equals(IPAddress.Broadcast) || packet.Destination.ToString().EndsWith(".255", StringComparison.Ordinal), $"never a unicast destination: {packet.Destination}");
            Assert.Equal(WakeOnLan.MagicPacket(Convert.FromHexString("d8bbc10a2b3c")), packet.Packet);
        });

        JsonElement result = JsonSerializer.SerializeToElement(execution.Result, Json);
        Assert.Equal(12, result.GetProperty("packetsSent").GetInt32());
        Assert.Equal(2, result.GetProperty("networks").GetInt32());
        Assert.Equal("lan-broadcast", result.GetProperty("method").GetString());
        Assert.True(result.GetProperty("confirmationPending").GetBoolean());
    }

    [Fact]
    public async Task A_wake_without_an_address_or_for_this_PC_itself_sends_nothing()
    {
        var sender = new RecordingSender();

        CommandExecution missing = await Wake(Handler(sender), new { targetPcId = "01J9ZQK7T0000000000000000A" });
        Assert.Equal("invalid-payload", missing.Failure?.Code);

        CommandExecution group = await Wake(Handler(sender), new { targetPcId = "01J9ZQK7T0000000000000000A", macAddress = "ff:ff:ff:ff:ff:ff" });
        Assert.Equal("invalid-payload", group.Failure?.Code);

        CommandExecution self = await Wake(Handler(sender, own: new HashSet<string> { Target }), new { targetPcId = "01J9ZQK7T0000000000000000A", macAddress = Target });
        Assert.Equal("wake-self", self.Failure?.Code);

        Assert.Empty(sender.Sent);
    }

    [Fact]
    public async Task No_local_network_is_a_limitation_and_packets_Windows_refused_are_a_failure()
    {
        CommandExecution alone = await Wake(Handler(new RecordingSender(), Array.Empty<WakeNetwork>()), new { targetPcId = "x", macAddress = Target });
        Assert.Equal("no-local-network", alone.Failure?.Code);
        Assert.True(alone.Failure?.Limitation);

        CommandExecution refused = await Wake(Handler(new RecordingSender { Accept = false }), new { targetPcId = "x", macAddress = Target });
        Assert.Equal("wake-send-failed", refused.Failure?.Code);
        Assert.Null(refused.Result);
    }

    [Fact]
    public async Task The_real_sender_puts_the_packet_on_the_wire()
    {
        using var listener = new UdpClient(new IPEndPoint(IPAddress.Loopback, 0));
        int port = ((IPEndPoint)listener.Client.LocalEndPoint!).Port;
        byte[] packet = WakeOnLan.MagicPacket(Convert.FromHexString("d8bbc10a2b3c"));

        Assert.True(new UdpWakePacketSender().Send(IPAddress.Loopback, IPAddress.Loopback, port, packet));

        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        UdpReceiveResult received = await listener.ReceiveAsync(timeout.Token);
        Assert.Equal(packet, received.Buffer);
    }

    [Fact]
    public void This_PCs_wired_adapter_is_read_without_administrator_and_is_one_of_its_own()
    {
        WakeReport report = WakeAdapter.Current();

        // The address itself is not printed: it is an identifier for a physical machine.
        _output.WriteLine($"wired adapter found: {report.MacAddress is not null}; armed by Windows: {report.Armed}");
        if (report.MacAddress is null)
        {
            Assert.False(report.Armed);
            return;
        }

        Assert.True(WakeOnLan.TryParseMac(report.MacAddress, out _));
        Assert.Contains(report.MacAddress, WakeAdapter.OwnAddresses());
        Assert.NotEmpty(WakeCommandHandler.LocalNetworks());
    }
}
