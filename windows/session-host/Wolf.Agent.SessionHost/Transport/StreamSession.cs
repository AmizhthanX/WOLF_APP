using System.Diagnostics;
using System.Runtime.Versioning;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using SIPSorcery.Net;
using Wolf.Agent.Core.Ipc;
using Wolf.Agent.SessionHost.Adaptation;
using Wolf.Agent.SessionHost.Audio;
using Wolf.Agent.SessionHost.Capture;
using Wolf.Agent.SessionHost.Clipboard;
using Wolf.Agent.SessionHost.Displays;
using Wolf.Agent.SessionHost.Encoding;
using Wolf.Agent.SessionHost.Input;

namespace Wolf.Agent.SessionHost.Transport;

/// <summary>Sends one signaling payload towards the client that asked for this stream.</summary>
public delegate Task SignalSender(string type, object payload);

/// <summary>
/// One remote desktop stream, from the request that asked for it to the frames on the wire.
///
/// This is where a client's wishes meet the machine's reality. A profile is a set of
/// ceilings and targets, not a contract: the display is whatever resolution it is, the
/// encoder does what it does, and where the two disagree the difference is reported as an
/// adjustment rather than quietly applied. A stream that silently ran at a third of the
/// requested frame rate would leave the operator blaming their network.
///
/// The stream does not begin encoding when it is created. It begins when the peer connects,
/// because a capture pipeline running before there is anywhere to send pictures is a
/// process reading somebody's screen for no reason.
/// </summary>
[SupportedOSPlatform("windows10.0.19041.0")]
public sealed class StreamSession : IDisposable
{
    /// <summary>The only codec this build encodes. Advertised as exactly that, never more.</summary>
    private const string SupportedCodec = "h264";

    private static readonly TimeSpan StatsInterval = TimeSpan.FromSeconds(2);

    /// <summary>
    /// How often the rate controller looks at the stream.
    ///
    /// Faster than the statistics it publishes: reacting to congestion two seconds late is
    /// two seconds of a stream nobody can use, while reporting two seconds late costs
    /// nothing but a slightly stale number on a dashboard.
    /// </summary>
    private static readonly TimeSpan AdaptInterval = TimeSpan.FromSeconds(1);

    /// <summary>
    /// What audio is allowed to cost.
    ///
    /// Fixed rather than adaptive. Opus at 96 kbps is transparent for desktop audio, and it
    /// is a rounding error beside a video stream measured in megabits — so when the link
    /// gets tight, the picture is what gives, not the sound.
    /// </summary>
    private const int AudioBitrateBps = 96_000;

    /// <summary>
    /// Shortest gap between key frames produced on a client's request.
    ///
    /// A browser losing packets steadily sends picture loss indications steadily, and a key
    /// frame is the largest thing the encoder makes. Answering every one would push a burst
    /// of them into a link that is already dropping packets, which is the cure making the
    /// disease worse.
    /// </summary>
    private static readonly TimeSpan KeyFrameCooldown = TimeSpan.FromMilliseconds(500);

    private readonly string _streamId;
    private readonly SignalStreamRequest _request;
    private readonly SignalSender _send;
    private readonly ILoggerFactory _loggers;
    private readonly ILogger<StreamSession> _logger;
    private readonly object _gate = new();

    private DisplayEnumerator? _displays;
    private CaptureDevice? _device;
    private CapturePipeline? _pipeline;
    private WebRtcTransport? _transport;
    private Timer? _statsTimer;
    private IpcDisplay? _display;
    private SignalProfile? _effectiveProfile;

    private readonly bool _audioAllowed;
    private readonly bool _clipboardAllowed;
    private readonly object _signalGate = new();
    private readonly List<SignalCandidate> _candidatesBeforeOffer = new();
    private bool _offerSent;
    private bool _gatheringFinishedBeforeOffer;

    private InputChannel? _input;
    private ClipboardChannel? _clipboard;
    private ControlChannel? _control;
    private AudioPipeline? _audio;
    private RateController? _rate;
    private Timer? _adaptTimer;
    private string? _degradedReason;

    private long _keyFramesSent;
    private long _lastKeyFrameTicks;

    // The size the stream starts at, after the profile's cap. Adaptation scales relative to
    // this rather than to the display, so a capped profile is not quietly re-expanded.
    private int _baseWidth;
    private int _baseHeight;

    /// <summary>The pins in force, after clamping to what this PC can actually do.</summary>
    private SignalOverrides _overrides = SignalOverrides.None;

    /// <summary>The display a switch is waiting on, until the pipeline reports it done.</summary>
    private IpcDisplay? _pendingDisplay;

    /// <summary>True when this session must capture through Desktop Duplication.</summary>
    private readonly bool _preferDuplication;
    private long _keyFramesFromRequests;
    private long _framesDroppedForTransport;
    private string _state = "STARTING";
    private bool _disposed;

    private StreamSession(
        string streamId,
        string sessionId,
        SignalStreamRequest request,
        bool audioAllowed,
        bool clipboardAllowed,
        SignalSender send,
        ILoggerFactory loggers,
        bool preferDuplication)
    {
        // Set for the host on the secure desktop, where Graphics Capture has no item to
        // create. Held for the life of the session so a display switch keeps the same API.
        _preferDuplication = preferDuplication;
        _audioAllowed = audioAllowed;
        _clipboardAllowed = clipboardAllowed;
        _streamId = streamId;
        SessionId = sessionId;
        _request = request;
        _send = send;
        _loggers = loggers;
        _logger = loggers.CreateLogger<StreamSession>();
    }

    public string StreamId => _streamId;

    /// <summary>The WOLF session that opened this stream.</summary>
    public string SessionId { get; }

    /// <summary>When the stream was negotiated, as an ISO-8601 instant.</summary>
    public string StartedAt { get; } = DateTimeOffset.UtcNow.ToString("o");

    public string State
    {
        get { lock (_gate) return _state; }
    }

    /// <summary>
    /// Negotiate and offer, or report exactly why not.
    ///
    /// Every failure path here emits a `stream.error` before returning null. A client that
    /// asked for a stream and got silence has no way to tell a broken agent from a slow one.
    /// </summary>
    public static async Task<StreamSession?> TryStartAsync(
        string streamId,
        string sessionId,
        SignalStreamRequest request,
        IReadOnlyList<IceServerSetting> iceServers,
        bool audioAllowed,
        bool clipboardAllowed,
        DisplayEnumerator displays,
        SignalSender send,
        ILoggerFactory loggers,
        bool preferDuplication = false)
    {
        var session = new StreamSession(
            streamId,
            sessionId,
            request,
            audioAllowed,
            clipboardAllowed,
            send,
            loggers,
            preferDuplication);

        try
        {
            if (await session.StartAsync(iceServers, displays).ConfigureAwait(false)) return session;
        }
        catch (Exception ex)
        {
            session._logger.LogError(ex, "Stream {Stream} could not be started.", streamId);
            await session.SendErrorAsync(
                "stream-failed",
                "The stream could not be started on this PC.",
                limitation: false,
                "The WOLF agent logs on the PC carry the reason under this stream id.")
                .ConfigureAwait(false);
        }

        session.Dispose();
        return null;
    }

    private async Task<bool> StartAsync(
        IReadOnlyList<IceServerSetting> iceServers,
        DisplayEnumerator displays)
    {
        var adjustments = new List<SignalAdjustment>();

        // 1. The display. A named display that has been unplugged is a different problem
        //    from a machine with no displays at all, and the client is told which.
        IReadOnlyList<IpcDisplay> attached = displays.Enumerate();
        if (attached.Count == 0)
        {
            await SendErrorAsync(
                "no-display",
                "This PC has no display attached, so there is nothing to capture.",
                limitation: true,
                "Attach a display, or use a virtual display driver.").ConfigureAwait(false);
            return false;
        }

        IpcDisplay? display = _request.DisplayId is null
            ? attached.FirstOrDefault(candidate => candidate.Primary) ?? attached[0]
            : attached.FirstOrDefault(candidate => candidate.Id == _request.DisplayId);

        if (display is null)
        {
            await SendErrorAsync(
                "no-display",
                $"Display '{_request.DisplayId}' is not attached to this PC any more.",
                limitation: true,
                "Refresh the display list and choose one of the displays now attached.")
                .ConfigureAwait(false);
            return false;
        }

        // 2. The codec. No guessing: if the client cannot decode what this machine encodes,
        //    that is the answer, and sending H.264 to a client that said it cannot decode it
        //    would produce a black rectangle and no explanation.
        if (!_request.ClientCodecs.Contains(SupportedCodec, StringComparer.Ordinal))
        {
            await SendErrorAsync(
                "codec-mismatch",
                $"This PC encodes {SupportedCodec}, and the client offered: " +
                string.Join(", ", _request.ClientCodecs) + ".",
                limitation: false,
                "Use a browser that decodes H.264, which every current browser does.")
                .ConfigureAwait(false);
            return false;
        }

        if (_request.CodecPreferenceIsUnmet())
        {
            adjustments.Add(new SignalAdjustment(
                "codecPreference",
                _request.Profile.CodecPreference.Count > 0
                    ? string.Join(",", _request.Profile.CodecPreference)
                    : "(none)",
                SupportedCodec,
                "This build encodes H.264 only."));
        }

        // 3. The profile, clamped to what this display and this build can actually do.
        int targetFps = ClampFrameRate(_request.Profile.TargetFps, display, adjustments);
        int bitrate = ClampBitrate(_request.Profile, adjustments);

        // 4. The pipeline. Created before the offer, because the offer has to describe the
        //    encoder that will actually produce the pictures.
        _device = CaptureDevice.TryCreate(_loggers.CreateLogger<CaptureDevice>());
        if (_device is null)
        {
            await SendErrorAsync(
                "capture-unsupported",
                "No Direct3D device could be created on this PC, so the screen cannot be captured.",
                limitation: true,
                "Update the graphics driver, or check that a display is connected to the GPU.")
                .ConfigureAwait(false);
            return false;
        }

        IntPtr? monitor = displays.FindMonitorHandle(display.Id);
        if (monitor is null)
        {
            await SendErrorAsync(
                "no-display",
                $"Display '{display.Id}' disappeared while the stream was starting.",
                limitation: true,
                "Try again; the display list will have been refreshed by then.").ConfigureAwait(false);
            return false;
        }

        _pipeline = CapturePipeline.TryCreate(
            _device,
            monitor.Value,
            targetFps,
            bitrate,
            OnEncodedFrame,
            _loggers,
            _request.Profile.MaxWidthPixels ?? 0,
            _request.Profile.MaxHeightPixels ?? 0,
            _preferDuplication);

        if (_pipeline is null)
        {
            await SendErrorAsync(
                "capture-unsupported",
                "The capture pipeline could not be built on this PC.",
                limitation: false,
                "The WOLF agent logs on the PC name the stage that failed.").ConfigureAwait(false);
            return false;
        }

        _displays = displays;
        _pipeline.DisplayLost += OnDisplayLost;
        _pipeline.DisplayChanged += OnDisplayChanged;

        // Desktop Duplication hands back the desktop without the pointer composited into it.
        // Reported rather than left to be discovered: an operator whose cursor is invisible
        // will assume their own machine or the network before they suspect the capture API,
        // and the difference between "missing" and "not captured on this PC" is the whole
        // point of the adjustments list.
        if (!_pipeline.CursorCaptured)
        {
            adjustments.Add(new SignalAdjustment(
                "cursor",
                "shown",
                "hidden",
                "This PC captures its screen with Desktop Duplication, which does not include " +
                "the mouse pointer."));
        }

        _display = display;
        _baseWidth = _pipeline.EncodedWidth;
        _baseHeight = _pipeline.EncodedHeight;

        // Pins are resolved before the offer goes out. A pinned resolution in particular has
        // to be applied here: `stream.ready` describes the picture the client will receive,
        // and advertising the full size only to start sending a smaller one would make the
        // viewer lay out for a stream that never arrives.
        _overrides = ClampOverrides(_request.Profile.Overrides, targetFps, bitrate, adjustments);

        if (_overrides.ResolutionScale is { } pinnedScale)
        {
            _pipeline.RequestEncodedSize(
                (int)Math.Round(_baseWidth * pinnedScale),
                (int)Math.Round(_baseHeight * pinnedScale));
        }

        // Input is refused until the cloud says who is driving. Building the channel here
        // rather than on the first grant means a batch arriving early is answered with the
        // reason it was refused instead of being dropped on the floor.
        _input = new InputChannel(
            _streamId,
            new InputInjector(display, _loggers.CreateLogger<InputInjector>()),
            _loggers.CreateLogger<InputChannel>());

        // The clipboard is watched only if this session was granted it. Nothing is read from
        // it otherwise — not read and withheld, not read at all.
        _clipboard = new ClipboardChannel(
            _streamId,
            OnClipboardOffer,
            OnClipboardUnsupported,
            _loggers.CreateLogger<ClipboardChannel>());

        _control = new ControlChannel(
            _streamId,
            _input,
            _clipboard,
            _loggers.CreateLogger<ControlChannel>());

        _clipboard.Start(_clipboardAllowed);

        // 5. Audio, if it was asked for and this session is allowed to hear the PC.
        string? audioCodec = null;

        if (_request.RequestAudio)
        {
            if (!_audioAllowed)
            {
                // Watching and listening are separate grants. A session with only `screen`
                // is told plainly rather than left wondering why the stream is silent.
                adjustments.Add(new SignalAdjustment(
                    "audioEnabled",
                    "true",
                    "false",
                    "This session was not granted permission to hear this PC."));
            }
            else
            {
                _audio = AudioPipeline.TryStart(AudioBitrateBps, OnEncodedAudio, _loggers);

                if (_audio is null)
                {
                    adjustments.Add(new SignalAdjustment(
                        "audioEnabled",
                        "true",
                        "false",
                        "This PC has no audio output WOLF can capture."));
                }
                else
                {
                    audioCodec = "opus";
                }
            }
        }

        bool scaled = _pipeline.EncodedWidth != display.WidthPixels ||
                      _pipeline.EncodedHeight != display.HeightPixels;

        _effectiveProfile = _request.Profile with
        {
            TargetFps = targetFps,

            // What is actually being encoded, so a client that asked for a cap can see it
            // was honoured — and one that did not can see the stream is full size.
            MaxWidthPixels = scaled ? _pipeline.EncodedWidth : null,
            MaxHeightPixels = scaled ? _pipeline.EncodedHeight : null,
            MinBitrateBps = Math.Min(_request.Profile.MinBitrateBps, bitrate),
            MaxBitrateBps = bitrate,
            CodecPreference = new[] { SupportedCodec },
            AudioEnabled = audioCodec is not null,
            Adaptive = _request.Profile.Adaptive,
            Overrides = _overrides,
        };

        // 6. The offer, describing the profile and level the encoder is really producing.
        string profileLevelId =
            H264ProfileLevel.FromParameterSets(_pipeline.ParameterSets) ?? H264ProfileLevel.Fallback;

        _logger.LogInformation(
            "Stream {Stream}: {Width}x{Height}@{Fps} on {Encoder}, profile-level-id {Profile}.",
            _streamId,
            _pipeline.Width,
            _pipeline.Height,
            targetFps,
            _pipeline.EncoderName,
            profileLevelId);

        _transport = WebRtcTransport.Create(
            iceServers,
            profileLevelId,
            _loggers.CreateLogger<WebRtcTransport>(),
            withAudio: audioCodec is not null);

        // Candidates found before the offer has gone out are held back rather than sent.
        // ICE gathering on a machine with several interfaces regularly finishes inside the
        // same call that starts it, and a client receiving candidates — or worse,
        // `ice.complete` — for a session it has not been offered yet has nowhere to put
        // them.
        _transport.CandidateGathered += candidate =>
        {
            lock (_signalGate)
            {
                if (!_offerSent)
                {
                    _candidatesBeforeOffer.Add(candidate);
                    return;
                }
            }

            Fire(_send(SignalTypes.IceCandidate, candidate));
        };

        _transport.GatheringComplete += () =>
        {
            lock (_signalGate)
            {
                if (!_offerSent)
                {
                    _gatheringFinishedBeforeOffer = true;
                    return;
                }
            }

            Fire(_send(SignalTypes.IceComplete, new { }));
        };

        _transport.ConnectionStateChanged += OnConnectionStateChanged;
        _transport.ControlMessageReceived += OnControlMessage;
        _transport.KeyFrameRequested += OnKeyFrameRequested;

        await SendReadyAsync(display, adjustments).ConfigureAwait(false);

        string offer = await _transport.CreateOfferAsync().ConfigureAwait(false);
        await _send(SignalTypes.SdpOffer, new { sdp = offer }).ConfigureAwait(false);
        await ReleaseHeldCandidatesAsync().ConfigureAwait(false);
        return true;
    }

    /// <summary>
    /// Tell the client what it is getting.
    ///
    /// Sent when the stream starts and again whenever the answer changes — switching display
    /// is the case that matters, because the size usually changes with it.
    /// </summary>
    private Task SendReadyAsync(IpcDisplay display, IReadOnlyList<SignalAdjustment> adjustments) =>
        _send(SignalTypes.StreamReady, new
        {
            negotiation = new SignalNegotiation(
                StreamId: _streamId,
                Display: display,
                VideoCodec: SupportedCodec,
                HardwareEncoded: _pipeline?.HardwareEncoded ?? false,
                AudioCodec: _audio is null ? null : "opus",
                EffectiveProfile: _effectiveProfile!,
                Adjustments: adjustments,
                StartedAt: StartedAt),
        });

    /// <summary>Send what ICE found while the offer was still being built.</summary>
    private async Task ReleaseHeldCandidatesAsync()
    {
        SignalCandidate[] held;
        bool finished;

        lock (_signalGate)
        {
            _offerSent = true;
            held = _candidatesBeforeOffer.ToArray();
            _candidatesBeforeOffer.Clear();
            finished = _gatheringFinishedBeforeOffer;
        }

        foreach (SignalCandidate candidate in held)
        {
            await _send(SignalTypes.IceCandidate, candidate).ConfigureAwait(false);
        }

        if (finished) await _send(SignalTypes.IceComplete, new { }).ConfigureAwait(false);
    }

    /// <summary>
    /// Frame rate, held to what the display can produce.
    ///
    /// Asking for 120 fps from a 60 Hz panel does not produce 120 distinct pictures; it
    /// produces 60 pictures and twice the encoding cost.
    /// </summary>
    private static int ClampFrameRate(int requested, IpcDisplay display, List<SignalAdjustment> adjustments)
    {
        int ceiling = display.RefreshHz is > 0 ? (int)Math.Round(display.RefreshHz.Value) : 240;
        int applied = Math.Clamp(requested, 1, ceiling);

        if (applied != requested)
        {
            adjustments.Add(new SignalAdjustment(
                "targetFps",
                requested.ToString(),
                applied.ToString(),
                $"The display runs at {ceiling} Hz."));
        }

        return applied;
    }

    private static int ClampBitrate(SignalProfile profile, List<SignalAdjustment> adjustments)
    {
        // The maximum is where the stream starts. Adaptation comes down from here when the
        // link cannot carry it, so the ceiling is what the operator asked for rather than a
        // number the stream is guaranteed to sit at.
        int applied = Math.Clamp(profile.MaxBitrateBps, 100_000, 200_000_000);

        if (applied != profile.MaxBitrateBps)
        {
            adjustments.Add(new SignalAdjustment(
                "maxBitrateBps",
                profile.MaxBitrateBps.ToString(),
                applied.ToString(),
                "Outside the range this encoder accepts."));
        }

        return applied;
    }

    /// <summary>
    /// Hold pinned values inside what this display and this encoder can actually do.
    ///
    /// A pin is a strong instruction, not an impossible one: pinning 120 fps on a 60 Hz
    /// panel asks for pictures that do not exist. Every clamp is reported as an adjustment,
    /// so the operator sees the number they typed next to the number they got instead of
    /// wondering why the setting looks ignored.
    /// </summary>
    private static SignalOverrides ClampOverrides(
        SignalOverrides? requested,
        int targetFps,
        int maxBitrateBps,
        List<SignalAdjustment> adjustments)
    {
        if (requested is null || !requested.Any) return SignalOverrides.None;

        int? frameRate = requested.FrameRate;
        if (frameRate is { } fps && fps > targetFps)
        {
            adjustments.Add(new SignalAdjustment(
                "overrides.frameRate",
                fps.ToString(),
                targetFps.ToString(),
                "Above what this display and profile can produce."));
            frameRate = targetFps;
        }

        int? bitrate = requested.BitrateBps;
        if (bitrate is { } bps && bps > maxBitrateBps)
        {
            adjustments.Add(new SignalAdjustment(
                "overrides.bitrateBps",
                bps.ToString(),
                maxBitrateBps.ToString(),
                "Above the bitrate ceiling this stream negotiated."));
            bitrate = maxBitrateBps;
        }

        // The ladder stops at half size because a smaller remote desktop stops being
        // readable. A pin may sit anywhere above that, including between the ladder's rungs.
        double? scale = requested.ResolutionScale is { } value ? Math.Clamp(value, 0.25, 1.0) : null;

        return new SignalOverrides(bitrate, frameRate, scale);
    }

    /// <summary>The controller's limits, pins included, from a negotiated profile.</summary>
    private static RateLimits LimitsFrom(SignalProfile profile)
    {
        SignalOverrides overrides = profile.Overrides ?? SignalOverrides.None;

        return new RateLimits(
            MinBitrateBps: Math.Min(profile.MinBitrateBps, profile.MaxBitrateBps),
            MaxBitrateBps: profile.MaxBitrateBps,
            TargetFrameRate: profile.TargetFps,
            Adaptive: profile.Adaptive,
            PinnedBitrateBps: overrides.BitrateBps,
            PinnedFrameRate: overrides.FrameRate,
            PinnedResolutionScale: overrides.ResolutionScale);
    }

    /// <summary>
    /// Put a freshly built controller's numbers into the pipeline.
    ///
    /// Used wherever a controller is created — stream start, and every profile change — so a
    /// pin is acted on immediately. Applying it is best-effort by nature: an encoder that
    /// refuses a bitrate or a size leaves the pipeline as it was and says so in the log, and
    /// the next adaptation interval reports the stream degraded.
    /// </summary>
    private void ApplyRate(CapturePipeline pipeline, RateController rate)
    {
        pipeline.TrySetBitrate(rate.BitrateBps);
        pipeline.SetTargetFrameRate(rate.FrameRate);

        pipeline.RequestEncodedSize(
            (int)Math.Round(_baseWidth * rate.ResolutionScale),
            (int)Math.Round(_baseHeight * rate.ResolutionScale));
    }

    private void OnEncodedFrame(EncodedVideoFrame frame)
    {
        WebRtcTransport? transport = _transport;
        if (transport is null) return;

        SignalProfile? profile = _effectiveProfile;
        uint duration = WebRtcTransport.VideoClockRate / (uint)Math.Max(1, profile?.TargetFps ?? 30);

        if (transport.SendFrame(frame.Data, duration))
        {
            if (frame.IsKeyFrame) Interlocked.Increment(ref _keyFramesSent);
        }
        else
        {
            Interlocked.Increment(ref _framesDroppedForTransport);
        }
    }

    /// <summary>
    /// The client cannot decode and has asked for a fresh picture.
    ///
    /// Worth answering promptly: without a key frame a client that lost one packet shows a
    /// frozen or smeared image until the encoder's own interval comes round, which is
    /// seconds of a stream that looks broken and is trivially recoverable.
    /// </summary>
    private void OnKeyFrameRequested()
    {
        long now = Stopwatch.GetTimestamp();
        long last = Interlocked.Read(ref _lastKeyFrameTicks);
        long cooldown = (long)(KeyFrameCooldown.TotalSeconds * Stopwatch.Frequency);

        if (last != 0 && now - last < cooldown) return;

        // Only the caller that wins the exchange sends one, so a burst of requests arriving
        // together still produces a single key frame.
        if (Interlocked.CompareExchange(ref _lastKeyFrameTicks, now, last) != last) return;

        if (_pipeline?.RequestKeyFrame() == true)
        {
            Interlocked.Increment(ref _keyFramesFromRequests);
            _logger.LogDebug("Stream {Stream}: sent a key frame the client asked for.", _streamId);
        }
    }

    /// <summary>
    /// Hand one Opus packet to the transport.
    ///
    /// Discarded until the peer is connected, like video: audio buffered through the
    /// connection handshake would arrive as a burst out of step with the picture.
    /// </summary>
    private void OnEncodedAudio(EncodedAudioFrame frame)
    {
        _transport?.SendAudio(
            frame.Data,
            (uint)(WebRtcTransport.AudioClockRate * frame.Duration.TotalSeconds));
    }

    private void OnConnectionStateChanged(RTCPeerConnectionState state)
    {
        switch (state)
        {
            case RTCPeerConnectionState.connected:
                StartStreaming();
                break;

            case RTCPeerConnectionState.disconnected:
                SetState("RECONNECTING", detail: "The connection to the client dropped.");
                break;

            case RTCPeerConnectionState.failed:
            case RTCPeerConnectionState.closed:
                SetState("OFFLINE", detail: "The connection to the client ended.");
                break;
        }
    }

    private void StartStreaming()
    {
        lock (_gate)
        {
            if (_disposed || _pipeline is null) return;

            _pipeline.Start();

            // A client that has just connected has no reference picture, so the next frame
            // has to be a key frame or it sees nothing until the encoder's own interval
            // comes round.
            if (!_pipeline.RequestKeyFrame() && !_pipeline.SupportsForcedKeyFrames)
            {
                _logger.LogInformation(
                    "This encoder does not force key frames; the client waits for the next scheduled one.");
            }

            // Adaptation starts with the stream, from the profile that was negotiated.
            _rate = new RateController(LimitsFrom(_effectiveProfile!));

            // Pinned levers take effect now rather than on the first adaptation interval, so
            // the operator does not spend a second watching the setting they made not happen.
            ApplyRate(_pipeline, _rate);

            _adaptTimer = new Timer(_ => Adapt(), null, AdaptInterval, AdaptInterval);
            _statsTimer = new Timer(_ => PublishStats(), null, StatsInterval, StatsInterval);
        }

        SetState("STREAMING", detail: null);
    }

    /// <summary>
    /// One interval of adaptation.
    ///
    /// Everything decided here comes from measurements: what the receiver reported losing,
    /// what congestion control estimates the path will carry, and what the encoder is
    /// costing. Nothing is inferred from how long the stream has been running or how it
    /// looks, because neither of those is evidence.
    /// </summary>
    private void Adapt()
    {
        CapturePipeline? pipeline = _pipeline;
        WebRtcTransport? transport = _transport;
        RateController? rate = _rate;

        if (pipeline is null || transport is null || rate is null || _disposed) return;

        try
        {
            RateDecision decision = rate.Observe(RateController.SignalsFrom(
                pipeline.Stats(),
                transport.EstimatedBitrateBps,
                transport.PacketLossPercent,
                transport.RoundTripMs));

            if (decision.BitrateChanged && !pipeline.TrySetBitrate(decision.BitrateBps))
            {
                // Some encoders only take a bitrate at configuration time. The frame rate is
                // the remaining lever, and the client is told the stream is degraded either
                // way rather than being left to wonder.
                _logger.LogDebug("The encoder refused a bitrate change to {Bitrate}.", decision.BitrateBps);
            }

            if (decision.FrameRateChanged) pipeline.SetTargetFrameRate(decision.FrameRate);

            if (decision.ResolutionChanged)
            {
                // Scaled from the size the stream started at, not from the display: a
                // profile that capped the resolution stays capped.
                pipeline.RequestEncodedSize(
                    (int)Math.Round(_baseWidth * decision.ResolutionScale),
                    (int)Math.Round(_baseHeight * decision.ResolutionScale));
            }

            if (decision.BitrateChanged || decision.FrameRateChanged || decision.ResolutionChanged)
            {
                _logger.LogInformation(
                    "Stream {Stream} adapted to {Kbps} kbps at {Fps} fps, {Scale:P0} of full size{Reason}.",
                    _streamId,
                    decision.BitrateBps / 1000,
                    decision.FrameRate,
                    decision.ResolutionScale,
                    decision.DegradedReason is null ? string.Empty : $" ({decision.DegradedReason})");
            }

            _degradedReason = decision.DegradedReason;
            SetState(decision.DegradedReason is null ? "STREAMING" : "DEGRADED", decision.DegradedReason);
        }
        catch (Exception ex)
        {
            // A controller fault must not take the stream with it. A stream running at a
            // fixed rate is worse than one that adapts and far better than one that stops.
            _logger.LogError(ex, "Adaptation failed for stream {Stream}; the rate is unchanged.", _streamId);
        }
    }

    private void SetState(string state, string? detail)
    {
        lock (_gate)
        {
            if (_state == state) return;
            _state = state;
        }

        Fire(_send(SignalTypes.StreamState, new
        {
            state,
            unavailableReason = (string?)null,
            detail,
        }));
    }

    private void PublishStats()
    {
        CapturePipeline? pipeline = _pipeline;
        WebRtcTransport? transport = _transport;
        if (pipeline is null || transport is null || _disposed) return;

        PipelineStats stats = pipeline.Stats();

        Fire(_send(SignalTypes.StreamStats, new
        {
            stats = new SignalStats(
                StreamId: _streamId,
                At: DateTimeOffset.UtcNow.ToString("o"),
                State: State,
                Route: transport.Route,
                Fps: Math.Round(stats.EncodedFps, 1),

                // What the encoder was last told to target, not a measurement of the wire.
                // The browser measures what actually arrived, and reports that separately.
                BitrateBps: _rate?.BitrateBps,
                WidthPixels: stats.WidthPixels,
                HeightPixels: stats.HeightPixels,

                // Round-trip time, jitter, and loss come from the receiver's own reports,
                // which this build does not yet read. Null says "not measured"; zero would
                // be a claim.
                LatencyMs: null,
                JitterMs: null,
                PacketLossPercent: null,
                KeyFramesSent: (int)Interlocked.Read(ref _keyFramesSent),
                Encoder: stats.Encoder,
                EncoderHardware: stats.HardwareEncoded,
                EncodeMsPerFrame: Math.Round(stats.MeanEncodeMs, 2),
                DegradedReason: _degradedReason),
        }));
    }

    /// <summary>
    /// Look at a different display on this PC.
    ///
    /// Switched in place. The client is told what it got with a fresh `stream.ready`,
    /// because the new display is usually a different size and a viewer that kept showing
    /// the old dimensions would be describing a picture that is no longer arriving.
    /// </summary>
    public async Task ApplyDisplayAsync(string? displayId)
    {
        CapturePipeline? pipeline = _pipeline;
        DisplayEnumerator? displays = _displays;
        if (pipeline is null || displays is null) return;

        IReadOnlyList<IpcDisplay> attached = displays.Enumerate();
        IpcDisplay? display = displayId is null
            ? attached.FirstOrDefault(candidate => candidate.Primary) ??
              (attached.Count > 0 ? attached[0] : null)
            : attached.FirstOrDefault(candidate => candidate.Id == displayId);

        if (display is null)
        {
            await SendErrorAsync(
                "no-display",
                $"Display '{displayId}' is not attached to this PC any more.",
                limitation: true,
                "Refresh the display list and choose one of the displays now attached.")
                .ConfigureAwait(false);
            return;
        }

        if (display.Id == _display?.Id) return;

        IntPtr? monitor = displays.FindMonitorHandle(display.Id);
        if (monitor is null)
        {
            await SendErrorAsync(
                "no-display",
                $"Display '{display.Id}' disappeared while switching to it.",
                limitation: true,
                "Try again; the display list will have been refreshed by then.").ConfigureAwait(false);
            return;
        }

        // Pointer coordinates are normalised against the display being streamed, so the
        // injector is told before the switch rather than after: input arriving in the
        // moment between the two belongs to the display the operator is now looking at.
        _display = display;
        _input?.Retarget(display);

        // Everything that depends on the new size waits for the switch to actually happen.
        // The request only queues it, so reading the encoded size here would read the old
        // display's — and on two monitors of different resolutions, tell the client to lay
        // out for a picture it is not going to get.
        _pendingDisplay = display;
        pipeline.RequestDisplay(monitor.Value);
    }

    /// <summary>
    /// The pipeline has finished switching display, or refused to.
    ///
    /// This is where the client is told, because this is the first moment there is anything
    /// true to tell it: the new display's size, the encoded size fitted to it, and a picture
    /// already arriving at those dimensions.
    /// </summary>
    private void OnDisplayChanged(bool switched)
    {
        CapturePipeline? pipeline = _pipeline;
        IpcDisplay? display = _pendingDisplay;
        _pendingDisplay = null;

        if (pipeline is null || display is null || _disposed) return;

        if (!switched)
        {
            _logger.LogWarning("Stream {Stream} could not switch display; it stays where it was.", _streamId);

            Fire(SendErrorAsync(
                "no-display",
                $"Display '{display.Id}' could not be captured. The stream is still showing the previous one.",
                limitation: true,
                "Try another display, or start the stream again."));
            return;
        }

        _baseWidth = pipeline.EncodedWidth;
        _baseHeight = pipeline.EncodedHeight;

        bool scaled = pipeline.EncodedWidth != display.WidthPixels ||
                      pipeline.EncodedHeight != display.HeightPixels;

        _effectiveProfile = _effectiveProfile! with
        {
            MaxWidthPixels = scaled ? pipeline.EncodedWidth : null,
            MaxHeightPixels = scaled ? pipeline.EncodedHeight : null,
        };

        _logger.LogInformation(
            "Stream {Stream} switched to display {Display}, encoding at {Width}x{Height}.",
            _streamId,
            display.Id,
            pipeline.EncodedWidth,
            pipeline.EncodedHeight);

        Fire(SendReadyAsync(display, Array.Empty<SignalAdjustment>()));
    }

    /// <summary>
    /// The display being streamed went away.
    ///
    /// Falling back to the primary keeps the stream alive through somebody unplugging a
    /// monitor, which is a great deal better than a viewer left on a frozen picture. The
    /// client is told which display it ended up on rather than silently moved.
    /// </summary>
    private void OnDisplayLost()
    {
        _logger.LogInformation("Stream {Stream}: the streamed display went away.", _streamId);

        Fire(SendErrorAsync(
            "no-display",
            "The display being streamed was disconnected. Switching to the primary display.",
            limitation: true,
            null));

        Fire(ApplyDisplayAsync(null));
    }

    /// <summary>
    /// Apply a profile change to the running stream.
    ///
    /// What can change in place is the rate policy: the bitrate ceiling, whether adaptation
    /// runs at all, and which levers the operator has pinned. Those are all decisions rather
    /// than plumbing, so they take effect on the next frame.
    ///
    /// Resolution and codec are not in that set. They mean a new encoder and a fresh
    /// negotiation, so a profile that changes them is answered with what could not be done
    /// rather than half-applied — with the exception of a pinned resolution scale, which is
    /// the one resolution change the pipeline can make without renegotiating.
    /// </summary>
    public async Task ApplyProfileAsync(SignalProfile profile)
    {
        CapturePipeline? pipeline = _pipeline;
        SignalProfile? effective = _effectiveProfile;
        if (pipeline is null || effective is null) return;

        var adjustments = new List<SignalAdjustment>();
        SignalOverrides overrides = ClampOverrides(
            profile.Overrides,
            effective.TargetFps,
            profile.MaxBitrateBps,
            adjustments);

        bool ceilingChanged = profile.MaxBitrateBps != effective.MaxBitrateBps;
        bool policyChanged = overrides != _overrides || profile.Adaptive != effective.Adaptive;

        if (!ceilingChanged && !policyChanged)
        {
            await SendErrorAsync(
                "profile-unsupported",
                "On a running stream WOLF can change the bitrate, adaptation, and pinned " +
                "settings. This profile changes something else.",
                limitation: false,
                "Stop the stream and start it again with the profile you want.").ConfigureAwait(false);
            return;
        }

        if (ceilingChanged)
        {
            if (!pipeline.TrySetBitrate(profile.MaxBitrateBps))
            {
                // Some encoders only accept a bitrate at configuration time. Said plainly:
                // carrying on with a controller that believes a ceiling the encoder never
                // took would make every later decision wrong.
                await SendErrorAsync(
                    "profile-unsupported",
                    "This encoder will not change its bitrate once a stream is running.",
                    limitation: true,
                    "Stop the stream and start it again with the profile you want.")
                    .ConfigureAwait(false);
                return;
            }

            effective = effective with
            {
                MaxBitrateBps = profile.MaxBitrateBps,
                MinBitrateBps = Math.Min(profile.MinBitrateBps, profile.MaxBitrateBps),
            };
        }

        _overrides = overrides;
        _effectiveProfile = effective with { Adaptive = profile.Adaptive, Overrides = overrides };

        // The controller works under the new policy from here. Rebuilt rather than adjusted
        // so a profile change also clears whatever it had backed off to, and so a lever that
        // has just been unpinned starts adapting from the profile instead of from wherever
        // the pin happened to leave it.
        var rate = new RateController(LimitsFrom(_effectiveProfile));
        _rate = rate;
        ApplyRate(pipeline, rate);

        _logger.LogInformation(
            "Stream {Stream} is now {Kbps} kbps at {Fps} fps, {Scale:P0} of full size{Pinned}.",
            _streamId,
            rate.BitrateBps / 1000,
            rate.FrameRate,
            rate.ResolutionScale,
            rate.HasPins ? " (pinned)" : string.Empty);

        // A pinned resolution changes the picture the client is receiving, and a viewer that
        // kept laying out for the old size would be describing a stream that stopped
        // arriving. Adjustments ride along, so a clamped pin is visible rather than inferred.
        if (_display is { } display)
        {
            await SendReadyAsync(display, adjustments).ConfigureAwait(false);
        }
    }

    public void AcceptAnswer(string sdp)
    {
        string? refusal = _transport?.TryAcceptAnswer(sdp);
        if (refusal is null) return;

        Fire(SendErrorAsync(
            "sdp-rejected",
            $"The client's answer could not be used: {refusal}.",
            limitation: false,
            "Start the stream again."));
    }

    public void AddCandidate(SignalCandidate candidate) => _transport?.AddRemoteCandidate(candidate);

    /// <summary>
    /// Input from the client, arriving on the data channel.
    ///
    /// The response goes back the same way rather than through the cloud: a rejection is
    /// about the batch that was just sent, and routing it through a server would deliver it
    /// long after the operator had stopped wondering.
    /// </summary>
    private void OnControlMessage(byte[] payload)
    {
        JsonNode? reply = _control?.Handle(payload);
        if (reply is null) return;

        _transport?.SendControl(JsonSerializer.SerializeToUtf8Bytes(reply, WolfIpc.Json));
    }

    /// <summary>
    /// Offer what somebody copied on the PC to the viewer.
    ///
    /// Sent on the data channel, never through the cloud: content that does not reach a
    /// server cannot be stored by one, which is the only way to keep the promise that WOLF
    /// does not retain clipboard contents.
    /// </summary>
    private void OnClipboardOffer(ClipboardOffer offer)
    {
        var message = new JsonObject
        {
            ["kind"] = "clipboard.content",
            ["streamId"] = _streamId,
            ["format"] = "text",
            ["text"] = offer.Text,
            ["origin"] = "pc",
            ["at"] = DateTimeOffset.UtcNow.ToString("o"),
        };

        _transport?.SendControl(JsonSerializer.SerializeToUtf8Bytes(message, WolfIpc.Json));
    }

    /// <summary>
    /// Say that the PC's clipboard holds something WOLF will not carry.
    ///
    /// Named, never sent. Somebody who copies a screenshot and finds nothing on the other
    /// machine should be told that images are not moved, rather than concluding clipboard
    /// sharing is broken.
    /// </summary>
    private void OnClipboardUnsupported(string describes)
    {
        var message = new JsonObject
        {
            ["kind"] = "clipboard.unsupported",
            ["streamId"] = _streamId,
            ["describes"] = describes,
        };

        _transport?.SendControl(JsonSerializer.SerializeToUtf8Bytes(message, WolfIpc.Json));
    }

    /// <summary>
    /// Apply the cloud's decision about who holds keyboard and mouse control.
    ///
    /// The host does not decide this and cannot: only the cloud sees every session
    /// competing for one PC. What the host does is enforce it, including the expiry — so a
    /// cloud that becomes unreachable cannot leave this machine controllable indefinitely.
    /// </summary>
    public void ApplyInputControl(bool granted, string? holderSessionId, DateTimeOffset? expiresAt)
    {
        _input?.ApplyControl(granted, holderSessionId, expiresAt);
    }

    /// <summary>Whether this stream is accepting input right now.</summary>
    public bool HasInputControl => _input?.HasControl ?? false;

    private Task SendErrorAsync(string code, string message, bool limitation, string? recommendedAction) =>
        _send(SignalTypes.StreamError, new
        {
            code,
            message,
            limitation,
            recommendedAction,
        });

    /// <summary>
    /// Run a signal send without making the caller wait for the cloud.
    ///
    /// These are called from the capture thread and from WebRTC's own callbacks. Blocking
    /// either on a network round trip would stall frame delivery.
    /// </summary>
    private void Fire(Task work)
    {
        _ = work.ContinueWith(
            task => _logger.LogWarning(task.Exception, "A signaling message could not be sent."),
            CancellationToken.None,
            TaskContinuationOptions.OnlyOnFaulted,
            TaskScheduler.Default);
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed) return;
            _disposed = true;
        }

        _adaptTimer?.Dispose();
        _statsTimer?.Dispose();

        // Stopped before the transport goes away, and stopped at all: a capture left running
        // would be a PC still listening to itself for a viewer who has gone.
        _audio?.Dispose();

        // Release anything the client was holding down before the transport goes away.
        // A stream that ends mid-chord would otherwise leave the machine with a stuck key.
        _input?.Relinquish();

        // Stops watching, and forgets even the hash of what was last copied.
        _clipboard?.Dispose();

        // Order matters: stop producing pictures before tearing down the thing that sends
        // them, so no frame is handed to a disposed transport.
        _pipeline?.Dispose();
        _transport?.Dispose();
        _device?.Dispose();

        _logger.LogInformation(
            "Stream {Stream} ended: {Frames} frames sent, {Keys} key frames ({Asked} asked for " +
            "by the client), {Dropped} dropped before connect, {Input} input events injected.",
            _streamId,
            _transport?.FramesSent ?? 0,
            Interlocked.Read(ref _keyFramesSent),
            Interlocked.Read(ref _keyFramesFromRequests),
            Interlocked.Read(ref _framesDroppedForTransport),
            _input?.EventsInjected ?? 0);
    }
}

internal static class StreamRequestExtensions
{
    /// <summary>
    /// Whether the client asked for a codec ahead of the one it is going to get.
    ///
    /// Only then is there an adjustment worth reporting: a client that expressed no
    /// preference, or preferred H.264, got exactly what it asked for.
    /// </summary>
    public static bool CodecPreferenceIsUnmet(this SignalStreamRequest request)
    {
        IReadOnlyList<string> preference = request.Profile.CodecPreference;
        if (preference.Count == 0) return false;
        return !string.Equals(preference[0], "h264", StringComparison.Ordinal);
    }
}
