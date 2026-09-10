using System.Runtime.Versioning;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;
using Wolf.Agent.Core.Ipc;

namespace Wolf.Agent.SessionHost.Input;

/// <summary>Sent back to the client only when something needs saying.</summary>
public sealed record InputRejection(
    [property: JsonPropertyName("streamId")] string StreamId,
    [property: JsonPropertyName("sequence")] long Sequence,
    /// <summary>rejected, unsupported, or not-permitted.</summary>
    [property: JsonPropertyName("outcome")] string Outcome,
    [property: JsonPropertyName("reason")] string Reason,
    [property: JsonPropertyName("limitation")] bool Limitation);

/// <summary>
/// Input arriving from a client, checked and injected.
///
/// This is the one part of WOLF where the cloud is not in the path. Input travels on the
/// WebRTC data channel straight from the browser to this process — deliberately, because
/// routing keystrokes through a server would add a round trip to every one of them — which
/// means **every check has to happen here**. Nothing upstream has looked at these bytes.
///
/// Two checks, in this order:
///
///  1. **Is this session allowed to drive?** The cloud arbitrates that and says so with an
///     `input.control` message carrying an expiry. Injection stops when the lease lapses
///     whether or not anything arrives to say so, because a cloud that becomes unreachable
///     must not leave a PC permanently controllable by whoever held it last.
///  2. **Is the event within its bounds?** Coordinates are normalised, keys are virtual-key
///     codes in 1..254, text is length-capped. The protocol says so and the cloud validates
///     it on the signaling path, but nothing validated *this* path, so it is validated here.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class InputChannel
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly InputInjector _injector;
    private readonly ILogger<InputChannel> _logger;
    private readonly string _streamId;
    private readonly object _gate = new();

    private string? _holderSessionId;
    private DateTimeOffset _leaseExpiresAt = DateTimeOffset.MinValue;
    private long _lastSequence = -1;
    private long _eventsInjected;

    /// <summary>
    /// Where to send events instead of injecting them, while the secure desktop is showing.
    ///
    /// Set when the client is watching the lock screen. This process cannot reach that
    /// desktop — only a process running on it can — so the events go to the host that is,
    /// having already been authorised here.
    ///
    /// The split is deliberate. Everything that decides *whether* input is allowed — the
    /// control lease, its expiry, the batch bounds, the stream it belongs to — depends on the
    /// session, and the session lives here. The far end injects what it is handed and knows
    /// nothing about leases, which is the right amount for a process that exists for the few
    /// seconds a screen is locked.
    /// </summary>
    private Action<JsonElement>? _forward;

    public InputChannel(string streamId, InputInjector injector, ILogger<InputChannel> logger)
    {
        _streamId = streamId;
        _injector = injector;
        _logger = logger;
    }

    /// <summary>
    /// Send authorised input somewhere else, or stop.
    ///
    /// Null puts injection back in this process. Called when the desktop locks and unlocks.
    /// </summary>
    public void ForwardTo(Action<JsonElement>? forward)
    {
        lock (_gate) _forward = forward;
    }

    public long EventsInjected => Interlocked.Read(ref _eventsInjected);

    /// <summary>Whether input would be accepted right now.</summary>
    public bool HasControl
    {
        get
        {
            lock (_gate) return _holderSessionId is not null && DateTimeOffset.UtcNow < _leaseExpiresAt;
        }
    }

    /// <summary>
    /// Apply the cloud's decision about who is driving.
    ///
    /// Losing control releases every modifier this process may have pressed. Without that, a
    /// client that loses the lease mid-chord leaves the machine with a stuck Ctrl, and the
    /// person sitting at it finds every keystroke turning into a shortcut.
    /// </summary>
    public void ApplyControl(bool granted, string? holderSessionId, DateTimeOffset? expiresAt)
    {
        bool hadControl = HasControl;

        lock (_gate)
        {
            if (granted && expiresAt is not null)
            {
                _holderSessionId = holderSessionId;
                _leaseExpiresAt = expiresAt.Value;
            }
            else
            {
                _holderSessionId = null;
                _leaseExpiresAt = DateTimeOffset.MinValue;
            }
        }

        if (granted)
        {
            _logger.LogInformation(
                "Stream {Stream}: input granted to session {Session} until {Expiry:o}.",
                _streamId,
                holderSessionId,
                expiresAt);
            return;
        }

        _logger.LogInformation("Stream {Stream}: input control released.", _streamId);
        if (hadControl) _injector.ReleaseAllModifiers();
    }

    /// <summary>
    /// Point input at a different display.
    ///
    /// Coordinates are normalised against the display being streamed, so switching monitors
    /// without telling the injector would land every click on the old one's rectangle.
    /// </summary>
    public void Retarget(IpcDisplay display) => _injector.Retarget(display);

    /// <summary>Called when the stream ends, so nothing is left held down.</summary>
    public void Relinquish()
    {
        if (HasControl) _injector.ReleaseAllModifiers();
        ApplyControl(granted: false, null, null);
    }

    /// <summary>
    /// Handle one batch from the data channel. Returns a response only when there is
    /// something worth saying — acknowledging every batch would double the message rate for
    /// no benefit.
    ///
    /// The batch arrives already separated from the control message that carried it, so what
    /// is checked here is the input itself: nothing upstream validated it, because input does
    /// not travel through the cloud.
    /// </summary>
    public InputRejection? Handle(JsonElement element)
    {
        InputBatchDto? batch;

        try
        {
            batch = element.Deserialize<InputBatchDto>(Json);
        }
        catch (Exception ex) when (ex is JsonException or ArgumentException or NotSupportedException)
        {
            _logger.LogWarning("Stream {Stream}: an input message could not be read.", _streamId);
            return new InputRejection(_streamId, -1, "rejected", "The input message could not be read.", false);
        }

        if (batch?.Events is null || batch.Events.Count == 0)
        {
            return new InputRejection(_streamId, batch?.Sequence ?? -1, "rejected", "The batch carried no events.", false);
        }

        if (batch.Events.Count > MaxEventsPerBatch)
        {
            return new InputRejection(
                _streamId,
                batch.Sequence,
                "rejected",
                $"A batch may carry at most {MaxEventsPerBatch} events.",
                false);
        }

        // The stream id in the batch has to be the stream this channel belongs to. The data
        // channel is per-stream, so a mismatch means something is confused at best.
        if (!string.Equals(batch.StreamId, _streamId, StringComparison.Ordinal))
        {
            return new InputRejection(_streamId, batch.Sequence, "rejected", "That batch is for a different stream.", false);
        }

        if (!HasControl)
        {
            lock (_gate)
            {
                bool expired = _holderSessionId is not null;
                return new InputRejection(
                    _streamId,
                    batch.Sequence,
                    "not-permitted",
                    expired
                        ? "The control lease has expired. Ask for control again."
                        : "This session does not hold keyboard and mouse control of this PC.",
                    false);
            }
        }

        NoteSequence(batch.Sequence);

        Action<JsonElement>? forward;
        lock (_gate) forward = _forward;

        if (forward is not null)
        {
            // Checked before it crosses the pipe, not after. The far end runs as SYSTEM on a
            // desktop nothing else can see, and it has no way to answer the client — so an
            // event that is out of bounds has to be refused *here*, where there is still
            // somebody to tell.
            foreach (InputEventDto entry in batch.Events)
            {
                InputRejection? refusal = RefuseForSecureDesktop(entry, batch.Sequence);
                if (refusal is not null) return refusal;
            }

            // Authorised here, injected elsewhere. Counted as injected because from the
            // session's point of view it was: the events left this channel having passed
            // every check, and what happens to them on the other desktop is reported by the
            // host that is on it.
            Interlocked.Add(ref _eventsInjected, batch.Events.Count);

            // The count, never the content. These are keystrokes on a lock screen and one of
            // them is somebody's password.
            _logger.LogDebug(
                "Stream {Stream}: forwarded {Count} event(s) to the secure desktop.",
                _streamId,
                batch.Events.Count);

            forward(element);
            return null;
        }

        foreach (InputEventDto entry in batch.Events)
        {
            InjectionResult result = Inject(entry);
            if (result.Injected)
            {
                Interlocked.Increment(ref _eventsInjected);
                continue;
            }

            // The first refusal ends the batch. Carrying on would inject the second half of
            // a chord whose first half was rejected, which is worse than stopping.
            return new InputRejection(
                _streamId,
                batch.Sequence,
                result.Limitation ? "unsupported" : "rejected",
                result.Reason ?? "The event could not be injected.",
                result.Limitation);
        }

        return null;
    }

    /// <summary>
    /// Whether an event is one the protocol allows.
    ///
    /// Kept apart from <see cref="Inject"/> because the events are not always injected here:
    /// while the secure desktop is showing they go to another process, and they have to have
    /// been checked before they leave. One list of bounds, read by both paths, so the two
    /// cannot drift into a batch that is refused on one desktop and accepted on the other.
    /// </summary>
    private static bool WithinBounds(InputEventDto entry) => entry.Type switch
    {
        "pointer.move" => InRange(entry.X) && InRange(entry.Y),

        "pointer.button" => InRange(entry.X) && InRange(entry.Y) && entry.Button is not null,

        "pointer.scroll" => InRange(entry.X) && InRange(entry.Y) &&
                            InScrollRange(entry.DeltaX) && InScrollRange(entry.DeltaY),

        "key" => entry.Key is >= 1 and <= 254,

        "text" => entry.Value is { Length: > 0 and <= MaxTextLength },

        "system.combo" => entry.Combo is not null,

        // An event type that does not exist. The protocol says this cannot happen, so it
        // means the sender is not speaking the protocol.
        _ => false,
    };

    private static InjectionResult OutOfBounds(InputEventDto entry) =>
        InjectionResult.Refused($"A '{entry.Type}' event was outside the bounds the protocol allows.");

    private InjectionResult Inject(InputEventDto entry)
    {
        if (!WithinBounds(entry)) return OutOfBounds(entry);

        return entry.Type switch
        {
            "pointer.move" => _injector.MovePointer(entry.X!.Value, entry.Y!.Value),

            "pointer.button" =>
                _injector.PressPointer(entry.Button!, entry.Action == "down", entry.X!.Value, entry.Y!.Value),

            "pointer.scroll" =>
                _injector.Scroll(entry.X!.Value, entry.Y!.Value, entry.DeltaX ?? 0, entry.DeltaY ?? 0),

            "key" => _injector.PressKey(entry.Key!.Value, entry.Action == "down", entry.ScanCode, entry.Extended),

            "text" => _injector.TypeText(entry.Value!),

            "system.combo" => _injector.SystemCombo(entry.Combo!),

            // Unreachable: WithinBounds named the same types and refused everything else.
            // Present because a switch expression must be total, and a refusal is the answer
            // that stays safe if the two ever stop naming the same list.
            _ => OutOfBounds(entry),
        };
    }

    /// <summary>
    /// Whether an event has to be refused rather than sent to the secure desktop.
    ///
    /// Two reasons, and both are answered here because the far end cannot answer anything:
    /// it injects on a desktop with no route back to the client.
    /// </summary>
    private InputRejection? RefuseForSecureDesktop(InputEventDto entry, long sequence)
    {
        if (!WithinBounds(entry))
        {
            return new InputRejection(_streamId, sequence, "rejected", OutOfBounds(entry).Reason!, false);
        }

        // System combinations are not delivered to a lock screen. Ctrl+Alt+Delete is
        // Winlogon's to produce and no injected input can stand in for it, and the rest —
        // Alt+Tab, Win+Tab — address a desktop that is not the one being shown. Saying so
        // beats forwarding them into a process that would drop them silently.
        if (entry.Type == "system.combo")
        {
            return new InputRejection(
                _streamId,
                sequence,
                "unsupported",
                "System key combinations are not delivered while the lock screen is showing. " +
                "Sign in first, and they work as usual.",
                true);
        }

        return null;
    }

    private void NoteSequence(long sequence)
    {
        long previous = Interlocked.Exchange(ref _lastSequence, sequence);

        if (previous >= 0 && sequence > previous + 1)
        {
            // Noted, never resent. Input that arrives late is worse than input that never
            // arrives: a click delivered a second after it was meant lands on whatever is
            // under the pointer by then.
            _logger.LogDebug(
                "Stream {Stream}: input batches {From}..{To} were lost.",
                _streamId,
                previous + 1,
                sequence - 1);
        }
    }

    private const int MaxEventsPerBatch = 128;
    private const int MaxTextLength = 512;

    private static bool InRange(double? value) => value is >= 0 and <= 1;

    private static bool InScrollRange(double? value) => value is null || value is >= -100 and <= 100;

    /// <summary>
    /// The wire shape, mirroring `packages/protocol/src/input.ts`.
    ///
    /// One flat record rather than a polymorphic hierarchy: the union is small, the fields
    /// that apply to each variant are checked at the point of use, and a deserialiser that
    /// has to pick a subtype from a discriminator is one more thing to get wrong on a path
    /// nothing upstream has validated.
    /// </summary>
    private sealed record InputBatchDto(
        [property: JsonPropertyName("streamId")] string StreamId,
        [property: JsonPropertyName("sequence")] long Sequence,
        [property: JsonPropertyName("sentAt")] string? SentAt,
        [property: JsonPropertyName("events")] IReadOnlyList<InputEventDto>? Events);

    private sealed record InputEventDto(
        [property: JsonPropertyName("type")] string Type,
        [property: JsonPropertyName("x")] double? X,
        [property: JsonPropertyName("y")] double? Y,
        [property: JsonPropertyName("button")] string? Button,
        [property: JsonPropertyName("action")] string? Action,
        [property: JsonPropertyName("deltaX")] double? DeltaX,
        [property: JsonPropertyName("deltaY")] double? DeltaY,
        [property: JsonPropertyName("key")] int? Key,
        [property: JsonPropertyName("scanCode")] int? ScanCode,
        [property: JsonPropertyName("extended")] bool Extended,
        [property: JsonPropertyName("value")] string? Value,
        [property: JsonPropertyName("combo")] string? Combo);
}
