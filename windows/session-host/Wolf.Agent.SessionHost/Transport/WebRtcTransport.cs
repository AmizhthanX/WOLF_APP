using System.Net.Sockets;
using Microsoft.Extensions.Logging;
using SIPSorcery.core;
using SIPSorcery.Net;
using SIPSorceryMedia.Abstractions;

namespace Wolf.Agent.SessionHost.Transport;

/// <summary>An ICE server as the cloud issued it. TURN credentials are short-lived.</summary>
public sealed record IceServerSetting(
    IReadOnlyList<string> Urls,
    string? Username,
    string? Credential);

/// <summary>
/// One WebRTC peer connection, carrying encoded video to one client.
///
/// The host is the offerer. It is the side that knows which encoder this machine has and at
/// what profile and level it is actually producing pictures, so an offer from here
/// describes reality; an offer from the browser would describe a hope.
///
/// Media never passes through the agent service or the cloud. This class owns the socket
/// that carries frames, and it lives in the session host — the process running as the
/// signed-in user — so a fault in the media path cannot be leveraged from inside a
/// LocalSystem service.
/// </summary>
public sealed class WebRtcTransport : IDisposable
{
    /// <summary>The RTP clock for video is 90 kHz, by specification, not by choice.</summary>
    public const uint VideoClockRate = 90_000;

    /// <summary>
    /// Dynamic payload type offered for H.264.
    ///
    /// What actually goes on the wire is whatever the answer agrees to, which is read back
    /// from the negotiated format rather than assumed — a client is entitled to answer with
    /// a different number, and sending on the wrong one produces a connection that looks
    /// healthy and shows nothing.
    /// </summary>
    private const int OfferedPayloadType = 96;

    /// <summary>
    /// Dynamic payload type offered for Opus.
    ///
    /// 111 by convention — it is what every browser uses, and matching it keeps the offer
    /// familiar to anything that reads it by eye.
    /// </summary>
    private const int OfferedAudioPayloadType = 111;

    /// <summary>Opus runs on a 48 kHz RTP clock, so 20 ms is 960 units.</summary>
    public const uint AudioClockRate = 48_000;

    private readonly RTCPeerConnection _peer;
    private readonly ILogger _logger;
    private readonly object _gate = new();

    private RTCDataChannel? _control;
    private readonly TWCCBitrateController _congestion = new();
    private int _negotiatedPayloadType = OfferedPayloadType;
    private int _negotiatedAudioPayloadType = OfferedAudioPayloadType;
    private long _framesSent;
    private long _bytesSent;
    private int _estimatedBitrateBps;
    private long _keyFrameRequests;
    private long _audioPacketsSent;
    private long _audioBytesSent;
    private double _packetLossPercent = -1;
    private double _roundTripMs = -1;
    private bool _disposed;

    /// <summary>A local candidate to be relayed to the client.</summary>
    public event Action<SignalCandidate>? CandidateGathered;

    /// <summary>No more local candidates are coming.</summary>
    public event Action? GatheringComplete;

    public event Action<RTCPeerConnectionState>? ConnectionStateChanged;

    /// <summary>A message from the client on the control data channel.</summary>
    public event Action<byte[]>? ControlMessageReceived;

    /// <summary>
    /// The client lost a picture and cannot decode until it gets a new one.
    ///
    /// Raised on a Picture Loss Indication, which is how a browser says its decoder is
    /// stuck. Without answering it, a client that drops one packet of a key frame shows a
    /// frozen or smeared picture until the encoder's own interval comes round — seconds of
    /// a stream that looks broken and is trivially recoverable.
    /// </summary>
    public event Action? KeyFrameRequested;

    private WebRtcTransport(RTCPeerConnection peer, ILogger logger)
    {
        _peer = peer;
        _logger = logger;
    }

    public RTCPeerConnectionState ConnectionState => _peer.connectionState;

    public long FramesSent => Interlocked.Read(ref _framesSent);

    public long BytesSent => Interlocked.Read(ref _bytesSent);

    /// <summary>How many times the client has asked for a new picture.</summary>
    public long KeyFrameRequests => Interlocked.Read(ref _keyFrameRequests);

    /// <summary>
    /// What congestion control believes the path will carry, or null before it has said.
    ///
    /// Comes from transport-wide congestion control, which the offer advertises and which
    /// browsers send. Null rather than a guess: a made-up estimate would drive the rate
    /// controller into decisions nothing supports.
    /// </summary>
    public int? EstimatedBitrateBps => _estimatedBitrateBps > 0 ? _estimatedBitrateBps : null;

    /// <summary>
    /// Loss the receiver reported, as a percentage, or null before it has reported any.
    ///
    /// Only the far end can measure this — it is the one counting what failed to arrive —
    /// so it is null until a receiver report comes back rather than being assumed to be zero.
    /// </summary>
    public double? PacketLossPercent => _packetLossPercent >= 0 ? _packetLossPercent : null;

    /// <summary>Round-trip time derived from the receiver's report, or null.</summary>
    public double? RoundTripMs => _roundTripMs >= 0 ? _roundTripMs : null;

    /// <summary>
    /// The route the connection settled on, or null before it has settled.
    ///
    /// Surfaced because "why is this laggy" is answered by "you are on relay" often enough
    /// that the operator should not have to ask.
    /// </summary>
    public string? Route { get; private set; }

    /// <summary>True when this connection carries an audio track as well as video.</summary>
    public bool HasAudio { get; private init; }

    public static WebRtcTransport Create(
        IReadOnlyList<IceServerSetting> iceServers,
        string profileLevelId,
        ILogger logger,
        bool withAudio = false)
    {
        var configuration = new RTCConfiguration
        {
            iceServers = iceServers
                .Where(server => server.Urls.Count > 0)
                .Select(server => new RTCIceServer
                {
                    urls = string.Join(',', server.Urls),
                    username = server.Username,
                    credential = server.Credential,
                })
                .ToList(),

            // "all" so host candidates can win on a LAN without ever touching a relay. The
            // cloud can ask for "relay" when diagnosing a broken direct path; it is never
            // the default, because relaying media that could have gone directly costs
            // latency and somebody's bandwidth.
            iceTransportPolicy = RTCIceTransportPolicy.all,

            // A machine with several NICs — a VPN, Hyper-V switches, a docking station —
            // has more than one plausible local address, and the one Windows would pick by
            // default is regularly not the one the client can reach.
            X_ICEIncludeAllInterfaceAddresses = true,
        };

        var peer = new RTCPeerConnection(configuration);
        var transport = new WebRtcTransport(peer, logger) { HasAudio = withAudio };

        var format = new VideoFormat(
            VideoCodecsEnum.H264,
            OfferedPayloadType,
            (int)VideoClockRate,
            H264ProfileLevel.Fmtp(profileLevelId));

        // SendOnly: this host sends pictures and does not receive any. Saying so in the SDP
        // stops the browser from allocating a decoder path and asking for a camera.
        peer.addTrack(new MediaStreamTrack(format, MediaStreamStatusEnum.SendOnly));

        if (withAudio)
        {
            // Also send-only. WOLF streams what the PC is playing; it does not carry the
            // operator's microphone back, and offering a receive direction would suggest
            // otherwise to anyone reading the SDP.
            var audio = new AudioFormat(
                AudioCodecsEnum.OPUS,
                OfferedAudioPayloadType,
                (int)AudioClockRate,
                2,
                "minptime=10;useinbandfec=1");

            peer.addTrack(new MediaStreamTrack(audio, MediaStreamStatusEnum.SendOnly));
        }

        transport.Attach();
        return transport;
    }

    private void Attach()
    {
        _peer.onicecandidate += candidate =>
        {
            if (candidate is null) return;

            CandidateGathered?.Invoke(new SignalCandidate(
                candidate.candidate,
                candidate.sdpMid,
                candidate.sdpMLineIndex,
                candidate.usernameFragment));
        };

        _peer.onicegatheringstatechange += state =>
        {
            _logger.LogDebug("ICE gathering is {State}.", state);
            if (state == RTCIceGatheringState.complete) GatheringComplete?.Invoke();
        };

        _peer.onconnectionstatechange += state =>
        {
            if (state == RTCPeerConnectionState.connected) Route = DescribeRoute();

            _logger.LogInformation(
                "The peer connection is {State}{Route}.",
                state,
                Route is null ? string.Empty : $" over {Route}");

            ConnectionStateChanged?.Invoke(state);
        };

        _peer.OnVideoFormatsNegotiated += formats =>
        {
            VideoFormat chosen = formats.FirstOrDefault();
            if (chosen.IsEmpty()) return;

            Interlocked.Exchange(ref _negotiatedPayloadType, chosen.FormatID);
            _logger.LogInformation(
                "The client accepted {Codec} on payload type {PayloadType}.",
                chosen.Codec,
                chosen.FormatID);
        };

        // Congestion control's own estimate. The library implements the delay-and-loss model
        // that transport-wide feedback is designed for; re-deriving one from raw feedback
        // here would be a second, worse implementation of a solved problem.
        _congestion.OnBitrateChange += (_, update) =>
        {
            Interlocked.Exchange(ref _estimatedBitrateBps, (int)update.Bitrate);
        };

        _peer.OnReceiveReport += (_, media, report) =>
        {
            if (media != SDPMediaTypesEnum.video) return;
            ProcessFeedback(report);
        };

        _peer.OnAudioFormatsNegotiated += formats =>
        {
            AudioFormat chosen = formats.FirstOrDefault();
            if (chosen.IsEmpty()) return;

            Interlocked.Exchange(ref _negotiatedAudioPayloadType, chosen.FormatID);
            _logger.LogInformation(
                "The client accepted {Codec} audio on payload type {PayloadType}.",
                chosen.Codec,
                chosen.FormatID);
        };

        _peer.ondatachannel += channel =>
        {
            _logger.LogInformation("The client opened the '{Label}' data channel.", channel.label);
            lock (_gate) _control = channel;
            channel.onmessage += (_, _, data) => ControlMessageReceived?.Invoke(data);
        };
    }

    /// <summary>
    /// Add the feedback this host can actually act on to an offer.
    ///
    /// SIPSorcery advertises `transport-cc` and nothing else, and its media format type does
    /// not expose the feedback list, so the line is added to the offer text on its way out.
    /// The local description is left alone: `rtcp-fb` describes what the *far end* may send,
    /// and nothing in the local stack gates RTCP parsing on it.
    ///
    /// Only `nack pli` is added. Generic `nack` asks the sender to retransmit specific lost
    /// packets, and this host keeps no packet history to retransmit from — advertising it
    /// would be a promise to a browser that WOLF cannot keep, and the browser would spend
    /// the stream asking for packets that are never coming.
    /// </summary>
    public static string AdvertiseFeedback(string sdp, int payloadType)
    {
        string wanted = $"a=rtcp-fb:{payloadType} nack pli";
        if (sdp.Contains(wanted, StringComparison.Ordinal)) return sdp;

        var lines = sdp.Replace("\r\n", "\n").Split('\n').ToList();

        // After the last feedback line for this payload type, or failing that after its
        // format parameters, so the attribute stays inside the media section it describes.
        int anchor = lines.FindLastIndex(line => line.StartsWith($"a=rtcp-fb:{payloadType} ", StringComparison.Ordinal));
        if (anchor < 0)
        {
            anchor = lines.FindLastIndex(line => line.StartsWith($"a=fmtp:{payloadType} ", StringComparison.Ordinal));
        }

        if (anchor < 0)
        {
            anchor = lines.FindLastIndex(line => line.StartsWith($"a=rtpmap:{payloadType} ", StringComparison.Ordinal));
        }

        // No media line for this payload type: leave the offer exactly as it was rather than
        // guessing where the attribute belongs.
        if (anchor < 0) return sdp;

        lines.Insert(anchor + 1, wanted);
        return string.Join("\r\n", lines);
    }

    /// <summary>
    /// Read what the receiver told us about the stream it is getting.
    ///
    /// Two kinds of report matter. Transport-wide feedback carries per-packet arrival times
    /// and is what the bitrate estimate is built from. The classic receiver report carries
    /// loss and the timestamps that round-trip time is derived from, and arrives even from a
    /// peer that does not implement the former.
    /// </summary>
    private void ProcessFeedback(RTCPCompoundPacket report)
    {
        // A picture loss indication is the client saying its decoder is stuck. It arrives as
        // its own packet with no reports attached, so it is checked before anything else.
        if (report.Feedback is { } feedback &&
            feedback.Header.PacketType == RTCPReportTypesEnum.PSFB &&
            feedback.Header.PayloadFeedbackMessageType
                is PSFBFeedbackTypesEnum.PLI or PSFBFeedbackTypesEnum.FIR)
        {
            Interlocked.Increment(ref _keyFrameRequests);
            KeyFrameRequested?.Invoke();
        }

        try
        {
            if (report.TWCCFeedback is { } twcc) _congestion.ProcessFeedback(twcc);
        }
        catch (Exception ex) when (ex is ArgumentException or IndexOutOfRangeException or OverflowException)
        {
            // Malformed feedback is not worth a broken stream. The estimate simply does not
            // move until the next report that parses.
            _logger.LogDebug(ex, "Congestion feedback could not be read.");
        }

        ReceptionReportSample? sample =
            report.ReceiverReport?.ReceptionReports?.FirstOrDefault() ??
            report.SenderReport?.ReceptionReports?.FirstOrDefault();

        if (sample is null) return;

        // FractionLost is eighths-of-a-percent style: a byte holding loss * 256.
        Interlocked.Exchange(ref _packetLossPercent, sample.FractionLost * 100.0 / 256.0);

        // Round trip, per RFC 3550: now, minus when the far end last heard from us, minus
        // how long it sat on the report. Zero LSR means it has not heard from us yet, and
        // subtracting from nothing would produce a confident wrong number.
        if (sample.LastSenderReportTimestamp != 0)
        {
            uint now = MiddleOfNtpNow();
            long elapsed = now - (long)sample.LastSenderReportTimestamp - sample.DelaySinceLastSenderReport;
            if (elapsed >= 0)
            {
                // The middle 32 bits of an NTP timestamp are 1/65536 of a second.
                Interlocked.Exchange(ref _roundTripMs, elapsed * 1000.0 / 65536.0);
            }
        }
    }

    /// <summary>The middle 32 bits of the current NTP timestamp, which is what RTCP carries.</summary>
    private static uint MiddleOfNtpNow()
    {
        DateTime epoch = new(1900, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        double seconds = (DateTime.UtcNow - epoch).TotalSeconds;
        return (uint)((ulong)(seconds * 65536.0) & 0xFFFFFFFF);
    }

    /// <summary>
    /// Create the offer and begin gathering candidates.
    ///
    /// Candidates are trickled as they are found rather than held until gathering finishes.
    /// Waiting would add the full gathering timeout — seconds, when a TURN server is
    /// configured and unreachable — to the time before the first frame.
    /// </summary>
    public async Task<string> CreateOfferAsync()
    {
        // A control channel for input has to exist before the offer, because a data channel
        // added afterwards needs a second negotiation. Nothing is sent on it until the
        // client opens its end.
        _control = await _peer.createDataChannel("wolf-control", new RTCDataChannelInit
        {
            ordered = true,
        }).ConfigureAwait(false);

        if (_control is not null)
        {
            _control.onmessage += (_, _, data) => ControlMessageReceived?.Invoke(data);
        }

        RTCSessionDescriptionInit offer = _peer.createOffer(new RTCOfferOptions());
        await _peer.setLocalDescription(offer).ConfigureAwait(false);

        // Advertised after the local description is set, so the offer that goes on the wire
        // says what this host will act on without disturbing the stack's own state.
        return AdvertiseFeedback(offer.sdp, OfferedPayloadType);
    }

    /// <summary>Apply the client's answer. Returns the reason it was refused, or null.</summary>
    public string? TryAcceptAnswer(string sdp)
    {
        SetDescriptionResultEnum result = _peer.setRemoteDescription(new RTCSessionDescriptionInit
        {
            type = RTCSdpType.answer,
            sdp = sdp,
        });

        if (result == SetDescriptionResultEnum.OK) return null;

        // The format lines say why, and carry nothing but codec parameters: no address, key or name.
        string formats = string.Join(" | ", sdp
            .Split('\n')
            .Select(line => line.Trim())
            .Where(line => line.StartsWith("m=", StringComparison.Ordinal) ||
                           line.StartsWith("a=rtpmap:", StringComparison.Ordinal) ||
                           line.StartsWith("a=fmtp:", StringComparison.Ordinal)));
        _logger.LogWarning("The client's answer was refused: {Result}. Its media formats: {Formats}.", result, formats);
        return result.ToString();
    }

    public void AddRemoteCandidate(SignalCandidate candidate)
    {
        try
        {
            _peer.addIceCandidate(new RTCIceCandidateInit
            {
                candidate = candidate.Candidate,
                sdpMid = candidate.SdpMid,
                sdpMLineIndex = (ushort)Math.Clamp(candidate.SdpMLineIndex ?? 0, 0, ushort.MaxValue),
                usernameFragment = candidate.UsernameFragment,
            });
        }
        catch (Exception ex) when (ex is ArgumentException or FormatException or InvalidOperationException)
        {
            // One malformed candidate is not fatal: ICE tries every other pair. Dropping the
            // connection here would turn a client's bad candidate into a failed stream.
            _logger.LogDebug(ex, "Ignored a candidate that could not be parsed.");
        }
    }

    /// <summary>
    /// Send one encoded access unit.
    ///
    /// Frames are dropped, not queued, while the connection is not up. A queue would hand
    /// the client a burst of stale pictures the moment it connected, and the newest frame is
    /// the only one worth having.
    /// </summary>
    public bool SendFrame(ReadOnlySpan<byte> accessUnit, uint durationRtpUnits)
    {
        if (_disposed || _peer.connectionState != RTCPeerConnectionState.connected) return false;

        try
        {
            _peer.VideoStream.SendH264Frame(
                durationRtpUnits,
                Volatile.Read(ref _negotiatedPayloadType),
                accessUnit.ToArray());

            Interlocked.Increment(ref _framesSent);
            Interlocked.Add(ref _bytesSent, accessUnit.Length);
            return true;
        }
        catch (Exception ex) when (ex is ObjectDisposedException or InvalidOperationException or SocketException)
        {
            _logger.LogDebug(ex, "A frame could not be sent; the connection is going away.");
            return false;
        }
    }

    /// <summary>
    /// Send one encoded Opus packet.
    ///
    /// Dropped rather than queued before the connection is up, for the same reason frames
    /// are: audio delivered late is audio out of step with the picture, which is worse than
    /// a moment of silence at the start.
    /// </summary>
    public bool SendAudio(ReadOnlySpan<byte> packet, uint durationRtpUnits)
    {
        if (_disposed || !HasAudio || _peer.connectionState != RTCPeerConnectionState.connected)
        {
            return false;
        }

        try
        {
            _peer.AudioStream.SendAudioFrame(
                durationRtpUnits,
                Volatile.Read(ref _negotiatedAudioPayloadType),
                packet.ToArray());

            Interlocked.Add(ref _audioBytesSent, packet.Length);
            Interlocked.Increment(ref _audioPacketsSent);
            return true;
        }
        catch (Exception ex) when (ex is ObjectDisposedException or InvalidOperationException or SocketException)
        {
            _logger.LogDebug(ex, "An audio packet could not be sent; the connection is going away.");
            return false;
        }
    }

    public long AudioPacketsSent => Interlocked.Read(ref _audioPacketsSent);

    public long AudioBytesSent => Interlocked.Read(ref _audioBytesSent);

    /// <summary>Send a control message to the client, if the channel is open.</summary>
    public bool SendControl(byte[] payload)
    {
        lock (_gate)
        {
            if (_control is null || !_control.IsOpened) return false;

            _control.send(payload, 0, payload.Length);
            return true;
        }
    }

    /// <summary>
    /// Name the route from the local candidate that won.
    ///
    /// The distinction is worth reporting precisely: `lan` and `p2p` both mean media is
    /// flowing directly, but only `relay` means somebody's TURN server is carrying it.
    /// </summary>
    private string? DescribeRoute()
    {
        ChecklistEntry? nominated = _peer.GetRtpChannel()?.NominatedEntry;
        if (nominated?.LocalCandidate is null || nominated.RemoteCandidate is null) return null;

        RTCIceCandidateType local = nominated.LocalCandidate.type;
        RTCIceCandidateType remote = nominated.RemoteCandidate.type;

        // Either end relaying means the media is relayed; it takes both ends being on a
        // host candidate for the traffic to be staying on the local network.
        if (local == RTCIceCandidateType.relay || remote == RTCIceCandidateType.relay) return "relay";
        return local == RTCIceCandidateType.host && remote == RTCIceCandidateType.host ? "lan" : "p2p";
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        try
        {
            _peer.close();
        }
        catch (Exception ex) when (ex is ObjectDisposedException or InvalidOperationException)
        {
            // Already gone.
        }

        _peer.Dispose();

        _logger.LogDebug(
            "Transport closed after {Frames} frames, {Bytes} bytes.",
            Interlocked.Read(ref _framesSent),
            Interlocked.Read(ref _bytesSent));
    }
}
