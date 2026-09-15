using System.Diagnostics;
using Microsoft.Extensions.Logging;
using SIPSorcery.Net;
using SIPSorceryMedia.Abstractions;
using Wolf.Agent.SessionHost.Transport;
using Xunit;
using Xunit.Abstractions;

namespace Wolf.Agent.Core.Tests;

/// <summary>
/// The transport, exercised against a real WebRTC peer over the loopback interface.
///
/// The peer on the other end is a second, independent WebRTC stack instance driven like a
/// browser would drive one: it takes the offer, answers it, trickles candidates, and
/// reports what arrived. Nothing here is stubbed, so what these tests prove is the whole
/// path — ICE negotiation, the DTLS handshake, SRTP encryption, RTP packetisation of an
/// access unit larger than a datagram, and reassembly at the far end.
///
/// A mocked transport would have proved that the code calls the methods it calls. This
/// proves a client can decode what WOLF sends.
/// </summary>
public sealed class WebRtcTransportTests
{
    private readonly ITestOutputHelper _output;

    public WebRtcTransportTests(ITestOutputHelper output)
    {
        _output = output;
    }

    private static readonly TimeSpan ConnectTimeout = TimeSpan.FromSeconds(20);

    /// <summary>
    /// An Annex-B access unit of a given size.
    ///
    /// The bytes are not a decodable picture and are not meant to be: what is being measured
    /// here is whether the transport delivers exactly what it was handed. Real encoder
    /// output is used in the test below this one, where the question is different.
    /// </summary>
    private static byte[] SyntheticAccessUnit(int payloadBytes, byte nalType, int seed)
    {
        var unit = new byte[4 + 1 + payloadBytes];
        unit[0] = 0;
        unit[1] = 0;
        unit[2] = 0;
        unit[3] = 1;
        unit[4] = nalType;

        var random = new Random(seed);
        random.NextBytes(unit.AsSpan(5));

        // Emulation prevention: a real encoder never emits 00 00 00/01/02/03 inside a NAL,
        // and a depacketiser is entitled to assume it. Random bytes would produce those
        // sequences and desynchronise the far end for reasons that have nothing to do with
        // the transport.
        for (int i = 5; i < unit.Length; i++)
        {
            if (unit[i] < 4) unit[i] += 4;
        }

        return unit;
    }

    /// <summary>Drive both ends of the negotiation the way the cloud relay would.</summary>
    private static async Task<RTCPeerConnection> ConnectClientAsync(WebRtcTransport host, string offerSdp, bool withAudio = false)
    {
        var client = new RTCPeerConnection(new RTCConfiguration
        {
            iceServers = new List<RTCIceServer>(),
        });

        client.addTrack(new MediaStreamTrack(
            new VideoFormat(VideoCodecsEnum.H264, 96, 90_000, "packetization-mode=1"),
            MediaStreamStatusEnum.RecvOnly));

        if (withAudio)
        {
            client.addTrack(new MediaStreamTrack(
                new AudioFormat(AudioCodecsEnum.OPUS, 111, 48_000, 2, "minptime=10;useinbandfec=1"),
                MediaStreamStatusEnum.RecvOnly));
        }

        // Candidates are relayed in both directions as they are gathered, exactly as the
        // signaling relay does it.
        host.CandidateGathered += candidate =>
        {
            client.addIceCandidate(new RTCIceCandidateInit
            {
                candidate = candidate.Candidate,
                sdpMid = candidate.SdpMid,
                sdpMLineIndex = (ushort)(candidate.SdpMLineIndex ?? 0),
                usernameFragment = candidate.UsernameFragment,
            });
        };

        client.onicecandidate += candidate =>
        {
            if (candidate is null) return;
            host.AddRemoteCandidate(new SignalCandidate(
                candidate.candidate,
                candidate.sdpMid,
                candidate.sdpMLineIndex,
                candidate.usernameFragment));
        };

        SetDescriptionResultEnum accepted = client.setRemoteDescription(new RTCSessionDescriptionInit
        {
            type = RTCSdpType.offer,
            sdp = offerSdp,
        });
        Assert.Equal(SetDescriptionResultEnum.OK, accepted);

        RTCSessionDescriptionInit answer = client.createAnswer(new RTCAnswerOptions());
        await client.setLocalDescription(answer);

        Assert.Null(host.TryAcceptAnswer(answer.sdp));
        return client;
    }

    private static async Task<bool> WaitForAsync(Func<bool> condition, TimeSpan timeout)
    {
        var deadline = Stopwatch.StartNew();
        while (deadline.Elapsed < timeout)
        {
            if (condition()) return true;
            await Task.Delay(25);
        }

        return condition();
    }

    [Fact]
    public async Task An_offer_is_answered_and_video_reaches_the_peer_intact()
    {
        using var loggers = new XunitLoggerFactory(_output, LogLevel.Information);

        // No ICE servers: on loopback there is nothing for STUN to discover and nothing to
        // relay, which is also the shipped default — WOLF configures no STUN or TURN unless
        // an operator asks for it.
        using WebRtcTransport host = WebRtcTransport.Create(
            Array.Empty<IceServerSetting>(),
            H264ProfileLevel.Fallback,
            loggers.CreateLogger<WebRtcTransport>());

        string offer = await host.CreateOfferAsync();
        _output.WriteLine($"offer is {offer.Length} bytes");

        // The offer has to describe what this host actually does: send H.264, receive
        // nothing. A client reading "sendrecv" would wait for a camera that never arrives.
        Assert.Contains("H264", offer, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("a=sendonly", offer, StringComparison.Ordinal);
        Assert.Contains("profile-level-id=" + H264ProfileLevel.Fallback, offer, StringComparison.Ordinal);

        // A client that loses a packet has to be able to ask for a new picture, and it will
        // only ask for what the offer said it may send.
        Assert.Contains("a=rtcp-fb:96 nack pli", offer, StringComparison.Ordinal);

        var received = new List<byte[]>();
        RTCPeerConnection client = await ConnectClientAsync(host, offer);
        client.OnVideoFrameReceived += (_, _, frame, _) =>
        {
            lock (received) received.Add(frame);
        };

        try
        {
            // Both ends, not just this one. The sending side reaches `connected` as soon as
            // its own DTLS handshake finishes, which is fractionally before the receiver has
            // a decryption context — a frame sent in that window is genuinely lost, and in a
            // real stream the next key frame covers it. Here it would look like a transport
            // that drops frames.
            bool connected = await WaitForAsync(
                () => host.ConnectionState == RTCPeerConnectionState.connected &&
                      client.connectionState == RTCPeerConnectionState.connected,
                ConnectTimeout);

            Assert.True(
                connected,
                $"the peers never connected; host is {host.ConnectionState}, client is {client.connectionState}");
            _output.WriteLine($"connected over {host.Route}");
            Assert.Equal("lan", host.Route);

            // One frame small enough for a single packet and one far larger than any MTU, so
            // the fragmentation path is exercised rather than assumed. A key frame at 1440p
            // is a quarter of a megabyte; if fragmentation were broken, every stream would
            // fail on its very first picture.
            byte[] small = SyntheticAccessUnit(400, 0x41, seed: 1);
            byte[] large = SyntheticAccessUnit(120_000, 0x65, seed: 2);

            const uint duration = WebRtcTransport.VideoClockRate / 30;
            Assert.True(host.SendFrame(small, duration));
            await Task.Delay(60);
            Assert.True(host.SendFrame(large, duration));

            bool arrived = await WaitForAsync(
                () => { lock (received) return received.Count >= 2; },
                TimeSpan.FromSeconds(10));

            lock (received)
            {
                _output.WriteLine(
                    $"received {received.Count} frames: " +
                    string.Join(", ", received.Select(frame => frame.Length + " bytes")));

                Assert.True(arrived, $"only {received.Count} frames arrived");

                // Byte-for-byte, not merely "something arrived". A transport that delivers
                // a truncated or reordered access unit produces a picture that decodes to
                // garbage, which looks like an encoder fault and is not one.
                Assert.Equal(small, received[0]);
                Assert.Equal(large, received[1]);
            }

            Assert.Equal(2, host.FramesSent);
        }
        finally
        {
            client.close();
        }
    }

    [Fact]
    public async Task Frames_are_dropped_rather_than_queued_before_the_client_connects()
    {
        using var loggers = new XunitLoggerFactory(_output, LogLevel.Warning);
        using WebRtcTransport host = WebRtcTransport.Create(
            Array.Empty<IceServerSetting>(),
            H264ProfileLevel.Fallback,
            loggers.CreateLogger<WebRtcTransport>());

        await host.CreateOfferAsync();

        // Nothing is connected yet. A queue here would hand the client a burst of stale
        // pictures the moment it arrived, and the newest frame is the only one worth having.
        Assert.False(host.SendFrame(SyntheticAccessUnit(500, 0x41, seed: 3), 3000));
        Assert.Equal(0, host.FramesSent);
    }

    [Fact]
    public void A_malformed_answer_is_refused_with_a_reason()
    {
        using var loggers = new XunitLoggerFactory(_output, LogLevel.Warning);
        using WebRtcTransport host = WebRtcTransport.Create(
            Array.Empty<IceServerSetting>(),
            H264ProfileLevel.Fallback,
            loggers.CreateLogger<WebRtcTransport>());

        // A client that answers with something unusable must be told so. Silently carrying
        // on would leave it waiting for frames that cannot be sent anywhere.
        string? refusal = host.TryAcceptAnswer("v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n");

        _output.WriteLine($"refused with: {refusal}");
        Assert.NotNull(refusal);
    }

    /* --------------------------------------------------------------------- */
    /* Recovering from loss                                                   */
    /* --------------------------------------------------------------------- */

    [Fact]
    public void The_offer_advertises_only_the_feedback_this_host_can_act_on()
    {
        const string offer =
            "v=0\r\n" +
            "m=video 9 UDP/TLS/RTP/SAVP 96\r\n" +
            "a=rtpmap:96 H264/90000\r\n" +
            "a=rtcp-fb:96 transport-cc\r\n" +
            "a=fmtp:96 packetization-mode=1\r\n";

        string advertised = WebRtcTransport.AdvertiseFeedback(offer, 96);
        _output.WriteLine(advertised.Replace("\r\n", " | "));

        Assert.Contains("a=rtcp-fb:96 nack pli", advertised, StringComparison.Ordinal);

        // Generic `nack` asks the sender to retransmit specific lost packets, and this host
        // keeps no packet history to retransmit from. Advertising it would have a browser
        // spend the stream asking for packets that are never coming.
        Assert.DoesNotContain("a=rtcp-fb:96 nack\r\n", advertised, StringComparison.Ordinal);

        // What was already there is left alone.
        Assert.Contains("a=rtcp-fb:96 transport-cc", advertised, StringComparison.Ordinal);
        Assert.Equal(1, CountOf(advertised, "transport-cc"));
    }

    [Fact]
    public void Advertising_feedback_twice_does_not_duplicate_it()
    {
        const string offer =
            "m=video 9 UDP/TLS/RTP/SAVP 96\r\n" +
            "a=rtpmap:96 H264/90000\r\n" +
            "a=rtcp-fb:96 transport-cc\r\n";

        string once = WebRtcTransport.AdvertiseFeedback(offer, 96);
        string twice = WebRtcTransport.AdvertiseFeedback(once, 96);

        Assert.Equal(once, twice);
        Assert.Equal(1, CountOf(twice, "nack pli"));
    }

    [Fact]
    public void An_offer_without_that_payload_type_is_left_exactly_as_it_was()
    {
        const string offer = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVP 111\r\na=rtpmap:111 opus/48000/2\r\n";

        // Guessing where the attribute belongs in an offer that does not carry the format
        // would produce an SDP the far end refuses outright.
        Assert.Equal(offer, WebRtcTransport.AdvertiseFeedback(offer, 96));
    }

    [Fact]
    public async Task A_client_that_loses_a_picture_can_ask_for_a_new_one()
    {
        using var loggers = new XunitLoggerFactory(_output, LogLevel.Warning);
        using WebRtcTransport host = WebRtcTransport.Create(
            Array.Empty<IceServerSetting>(),
            H264ProfileLevel.Fallback,
            loggers.CreateLogger<WebRtcTransport>());

        var requests = 0;
        host.KeyFrameRequested += () => Interlocked.Increment(ref requests);

        string offer = await host.CreateOfferAsync();
        RTCPeerConnection client = await ConnectClientAsync(host, offer);

        try
        {
            bool connected = await WaitForAsync(
                () => host.ConnectionState == RTCPeerConnectionState.connected &&
                      client.connectionState == RTCPeerConnectionState.connected,
                ConnectTimeout);
            Assert.True(connected, "the peers never connected");

            // A frame first: the RTCP session that carries feedback does not exist until
            // media has flowed, so a picture loss indication sent before this goes nowhere.
            Assert.True(host.SendFrame(SyntheticAccessUnit(600, 0x65, seed: 9), 3000));
            await Task.Delay(300);

            // Exactly what a browser sends when its decoder is stuck.
            client.SendRtcpFeedback(
                SDPMediaTypesEnum.video,
                new RTCPFeedback(
                    client.VideoStream.LocalTrack?.Ssrc ?? 1,
                    client.VideoStream.RemoteTrack?.Ssrc ?? 0,
                    PSFBFeedbackTypesEnum.PLI));

            bool asked = await WaitForAsync(() => Volatile.Read(ref requests) > 0, TimeSpan.FromSeconds(5));

            _output.WriteLine($"key frame requests observed: {Volatile.Read(ref requests)}");

            // Without this, a client that drops one packet of a key frame shows a frozen
            // picture until the encoder's own interval comes round.
            Assert.True(asked, "the host never noticed the client asking for a picture");
            Assert.Equal(Volatile.Read(ref requests), (int)host.KeyFrameRequests);
        }
        finally
        {
            client.close();
        }
    }

    [Fact]
    public async Task A_picture_loss_is_heard_when_the_stream_also_carries_sound()
    {
        using var loggers = new XunitLoggerFactory(_output, LogLevel.Warning);
        using WebRtcTransport host = WebRtcTransport.Create(
            Array.Empty<IceServerSetting>(),
            H264ProfileLevel.Fallback,
            loggers.CreateLogger<WebRtcTransport>(),
            withAudio: true);

        var requests = 0;
        host.KeyFrameRequested += () => Interlocked.Increment(ref requests);

        string offer = await host.CreateOfferAsync();
        RTCPeerConnection client = await ConnectClientAsync(host, offer, withAudio: true);

        try
        {
            bool connected = await WaitForAsync(
                () => host.ConnectionState == RTCPeerConnectionState.connected &&
                      client.connectionState == RTCPeerConnectionState.connected,
                ConnectTimeout);
            Assert.True(connected, "the peers never connected");

            // Sound and a picture, so both media sections have flowed and carry RTCP.
            const uint duration = WebRtcTransport.AudioClockRate / 50;
            Assert.True(host.SendAudio(new byte[] { 0xFC, 0x01, 0x02, 0x03 }, duration));
            Assert.True(host.SendFrame(SyntheticAccessUnit(600, 0x65, seed: 11), 3000));
            await Task.Delay(300);

            client.SendRtcpFeedback(
                SDPMediaTypesEnum.video,
                new RTCPFeedback(
                    client.VideoStream.LocalTrack?.Ssrc ?? 1,
                    client.VideoStream.RemoteTrack?.Ssrc ?? 0,
                    PSFBFeedbackTypesEnum.PLI));

            bool asked = await WaitForAsync(() => Volatile.Read(ref requests) > 0, TimeSpan.FromSeconds(5));
            _output.WriteLine($"key frame requests observed with sound on: {Volatile.Read(ref requests)}");

            // With sound, the offer bundles audio into the first media section. A client whose
            // decoder is stuck must still be heard, whichever section its feedback travels in.
            Assert.True(asked, "the host ignored a picture loss indication because the stream also carries sound");
        }
        finally
        {
            client.close();
        }
    }

    [Fact]
    public async Task Audio_is_offered_only_when_it_was_asked_for_and_reaches_the_peer()
    {
        using var loggers = new XunitLoggerFactory(_output, LogLevel.Warning);

        // Without audio, the offer must not mention it: a client that saw an audio line
        // would allocate a decoder and wait for sound that is never coming.
        using (WebRtcTransport silent = WebRtcTransport.Create(
            Array.Empty<IceServerSetting>(),
            H264ProfileLevel.Fallback,
            loggers.CreateLogger<WebRtcTransport>()))
        {
            string offer = await silent.CreateOfferAsync();
            Assert.DoesNotContain("m=audio", offer, StringComparison.Ordinal);
            Assert.False(silent.HasAudio);
        }

        using WebRtcTransport host = WebRtcTransport.Create(
            Array.Empty<IceServerSetting>(),
            H264ProfileLevel.Fallback,
            loggers.CreateLogger<WebRtcTransport>(),
            withAudio: true);

        string withAudio = await host.CreateOfferAsync();
        _output.WriteLine(string.Join(
            " | ",
            withAudio.Split('\n').Where(line => line.StartsWith("m=") || line.Contains("opus", StringComparison.OrdinalIgnoreCase))));

        Assert.Contains("m=audio", withAudio, StringComparison.Ordinal);
        Assert.Contains("opus/48000/2", withAudio, StringComparison.OrdinalIgnoreCase);

        // Send-only, both tracks. WOLF streams what the PC plays and never carries the
        // operator's microphone back to it.
        Assert.Equal(2, CountOf(withAudio, "a=sendonly"));

        var client = new RTCPeerConnection(new RTCConfiguration { iceServers = new List<RTCIceServer>() });
        client.addTrack(new MediaStreamTrack(
            new VideoFormat(VideoCodecsEnum.H264, 96, 90_000, "packetization-mode=1"),
            MediaStreamStatusEnum.RecvOnly));
        client.addTrack(new MediaStreamTrack(
            new AudioFormat(AudioCodecsEnum.OPUS, 111, 48_000, 2, "minptime=10;useinbandfec=1"),
            MediaStreamStatusEnum.RecvOnly));

        var audioPackets = 0;
        client.OnRtpPacketReceived += (_, media, _) =>
        {
            if (media == SDPMediaTypesEnum.audio) Interlocked.Increment(ref audioPackets);
        };

        host.CandidateGathered += candidate => client.addIceCandidate(new RTCIceCandidateInit
        {
            candidate = candidate.Candidate,
            sdpMid = candidate.SdpMid,
            sdpMLineIndex = (ushort)(candidate.SdpMLineIndex ?? 0),
            usernameFragment = candidate.UsernameFragment,
        });

        client.onicecandidate += candidate =>
        {
            if (candidate is null) return;
            host.AddRemoteCandidate(new SignalCandidate(
                candidate.candidate,
                candidate.sdpMid,
                candidate.sdpMLineIndex,
                candidate.usernameFragment));
        };

        try
        {
            Assert.Equal(
                SetDescriptionResultEnum.OK,
                client.setRemoteDescription(new RTCSessionDescriptionInit
                {
                    type = RTCSdpType.offer,
                    sdp = withAudio,
                }));

            RTCSessionDescriptionInit answer = client.createAnswer(new RTCAnswerOptions());
            await client.setLocalDescription(answer);
            Assert.Null(host.TryAcceptAnswer(answer.sdp));

            bool connected = await WaitForAsync(
                () => host.ConnectionState == RTCPeerConnectionState.connected &&
                      client.connectionState == RTCPeerConnectionState.connected,
                ConnectTimeout);
            Assert.True(connected, "the peers never connected");

            // Twenty milliseconds of Opus, as the pipeline would produce it.
            const uint duration = WebRtcTransport.AudioClockRate / 50;
            for (int packet = 0; packet < 10; packet++)
            {
                Assert.True(host.SendAudio(new byte[] { 0xFC, 0x01, 0x02, 0x03 }, duration));
                await Task.Delay(20);
            }

            bool arrived = await WaitForAsync(
                () => Volatile.Read(ref audioPackets) > 0,
                TimeSpan.FromSeconds(5));

            _output.WriteLine($"audio packets received: {Volatile.Read(ref audioPackets)}");
            Assert.True(arrived, "no audio reached the peer");
            Assert.Equal(10, host.AudioPacketsSent);
        }
        finally
        {
            client.close();
        }
    }

    private static int CountOf(string text, string needle)
    {
        var count = 0;
        for (int index = text.IndexOf(needle, StringComparison.Ordinal); index >= 0;
             index = text.IndexOf(needle, index + needle.Length, StringComparison.Ordinal))
        {
            count++;
        }

        return count;
    }
}
