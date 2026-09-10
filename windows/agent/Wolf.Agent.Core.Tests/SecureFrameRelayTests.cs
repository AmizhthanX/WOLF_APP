using System.Text.Json;
using Wolf.Agent.Core.Ipc;
using Xunit;
using Xunit.Abstractions;

namespace Wolf.Agent.Core.Tests;

/// <summary>
/// Carrying the lock screen's frames to the connection that is already open.
///
/// The secure host cannot speak WebRTC — it is a process on a desktop that exists for a few
/// seconds at a time — so it encodes and hands the frames to the service, which passes them
/// to the user host, which puts them on the track it already holds. Two pipe hops for a
/// still picture at ten frames a second.
///
/// **The path has never run**, for the reasons in <see cref="SecureDesktopTests"/>. What runs
/// here is the part that would corrupt it quietly: the encoding of a frame across those hops,
/// and the size bound that decides whether a key frame fits at all. A mistake in either
/// produces a stream that looks like a decoder bug rather than a plumbing one.
/// </summary>
public sealed class SecureFrameRelayTests
{
    private readonly ITestOutputHelper _output;

    public SecureFrameRelayTests(ITestOutputHelper output)
    {
        _output = output;
    }

    /// <summary>A frame's worth of bytes that is not all zeroes, so a truncation shows up.</summary>
    private static byte[] Frame(int length)
    {
        var data = new byte[length];
        new Random(20260910).NextBytes(data);

        // Real access units start with a start code. Included so a test that accidentally
        // trimmed a prefix would fail rather than pass on random noise.
        data[0] = 0x00;
        data[1] = 0x00;
        data[2] = 0x00;
        data[3] = 0x01;
        return data;
    }

    [Fact]
    public void A_frame_survives_both_hops_unchanged()
    {
        byte[] original = Frame(64 * 1024);

        // Hop one: the secure host to the service.
        var fromHost = new HostFrameMessage(
            Data: Convert.ToBase64String(original),
            KeyFrame: true,
            WidthPixels: 1920,
            HeightPixels: 1080,
            TimestampMs: 1234.5);

        string wire = JsonSerializer.Serialize(fromHost, WolfIpc.Json);
        HostFrameMessage received = JsonSerializer.Deserialize<HostFrameMessage>(wire, WolfIpc.Json)!;

        // Hop two: the service to the user host.
        var relayed = new ServiceSecureFrameMessage(
            received.Data,
            received.KeyFrame,
            received.WidthPixels,
            received.HeightPixels);

        string relayedWire = JsonSerializer.Serialize(relayed, WolfIpc.Json);
        ServiceSecureFrameMessage arrived =
            JsonSerializer.Deserialize<ServiceSecureFrameMessage>(relayedWire, WolfIpc.Json)!;

        byte[] decoded = Convert.FromBase64String(arrived.Data);

        // Byte for byte. H.264 does not degrade gracefully: one wrong byte in an access unit
        // is a corrupt picture, and one missing byte is a decoder that gives up.
        Assert.Equal(original, decoded);
        Assert.True(arrived.KeyFrame);
        Assert.Equal(1920, arrived.WidthPixels);
    }

    [Fact]
    public void A_key_frame_of_a_locked_screen_fits_inside_the_channel()
    {
        // The bound that matters. The secure host is asked for 1080p at 2 Mbps, where a key
        // frame is a few hundred kilobytes — but a lock screen with a photograph on it is the
        // worst case, so this checks something considerably larger than the average.
        byte[] large = Frame(768 * 1024);

        var message = new HostFrameMessage(
            Data: Convert.ToBase64String(large),
            KeyFrame: true,
            WidthPixels: 1920,
            HeightPixels: 1080,
            TimestampMs: 0);

        string wire = JsonSerializer.Serialize(message, WolfIpc.Json);

        _output.WriteLine(
            $"{large.Length / 1024} KB frame becomes a {wire.Length / 1024} KB message; " +
            $"the cap is {IpcChannel.MaxFrameMessageBytes / 1024} KB");

        Assert.True(
            wire.Length < IpcChannel.MaxFrameMessageBytes,
            $"a {large.Length / 1024} KB key frame does not fit in the frame channel");

        // And the ordinary control channel is deliberately far smaller: it carries messages
        // that are well under a kilobyte, and a cap exists to bound what a peer that has gone
        // wrong can make the reader allocate.
        Assert.True(IpcChannel.MaxMessageBytes < IpcChannel.MaxFrameMessageBytes);
    }

    [Fact]
    public void Base64_is_a_third_larger_and_that_is_the_trade()
    {
        // Stated as a test so the cost is visible rather than discovered. A length-prefixed
        // binary framing would save this and cost a second protocol to get wrong, on a path
        // carrying a still picture at ten frames a second.
        byte[] frame = Frame(300 * 1024);
        string encoded = Convert.ToBase64String(frame);

        double overhead = (double)encoded.Length / frame.Length;
        _output.WriteLine($"base64 overhead: {overhead:P0}");

        Assert.InRange(overhead, 1.3, 1.4);
    }

    [Fact]
    public void Stopping_capture_is_a_message_with_nothing_else_in_it()
    {
        // The host reads `Capture` and nothing else on a stop. Sending a stop that also
        // carried a resolution would invite a reader that acted on both.
        var stop = new ServiceSecureCaptureMessage(
            Capture: false,
            MaxWidthPixels: 0,
            MaxHeightPixels: 0,
            TargetFps: 0,
            BitrateBps: 0);

        string wire = JsonSerializer.Serialize(stop, WolfIpc.Json);
        ServiceSecureCaptureMessage parsed =
            JsonSerializer.Deserialize<ServiceSecureCaptureMessage>(wire, WolfIpc.Json)!;

        Assert.False(parsed.Capture);
        Assert.Equal("service.secure-capture", parsed.Kind);
    }

    [Fact]
    public void The_secure_desktop_is_captured_modestly_on_purpose()
    {
        // A lock screen is a still picture that changes when somebody touches the keyboard.
        // Full resolution at sixty frames a second would spend a SYSTEM process' worth of GPU
        // re-encoding the same pixels, and every frame crosses two pipes to get anywhere.
        var request = new ServiceSecureCaptureMessage(
            Capture: true,
            MaxWidthPixels: 1920,
            MaxHeightPixels: 1080,
            TargetFps: 10,
            BitrateBps: 2_000_000);

        Assert.True(request.TargetFps <= 15, "the lock screen does not need a high frame rate");
        Assert.True(request.MaxWidthPixels <= 1920, "the lock screen does not need full resolution");
        Assert.True(request.BitrateBps <= 4_000_000, "the lock screen does not need a high bitrate");

        // At this rate a frame is small enough that two pipe hops and base64 are not the
        // thing anybody would notice.
        double averageFrameBytes = request.BitrateBps / 8.0 / request.TargetFps;
        _output.WriteLine($"average frame: {averageFrameBytes / 1024:F0} KB before base64");

        Assert.True(averageFrameBytes * 1.34 < IpcChannel.MaxFrameMessageBytes);
    }

    [Fact]
    public void Every_secure_message_names_itself()
    {
        // The host and the service both dispatch on `kind`. A message whose kind did not
        // serialise would be silently ignored by the far end rather than failing.
        Assert.Equal(
            "host.frame",
            JsonSerializer.Deserialize<HostFrameMessage>(
                JsonSerializer.Serialize(
                    new HostFrameMessage("", false, 0, 0, 0), WolfIpc.Json), WolfIpc.Json)!.Kind);

        Assert.Equal(
            "service.secure-frame",
            JsonSerializer.Deserialize<ServiceSecureFrameMessage>(
                JsonSerializer.Serialize(
                    new ServiceSecureFrameMessage("", false, 0, 0), WolfIpc.Json), WolfIpc.Json)!.Kind);

        Assert.Equal(
            "service.secure-state",
            JsonSerializer.Deserialize<ServiceSecureStateMessage>(
                JsonSerializer.Serialize(
                    new ServiceSecureStateMessage(true, null), WolfIpc.Json), WolfIpc.Json)!.Kind);
    }
}
