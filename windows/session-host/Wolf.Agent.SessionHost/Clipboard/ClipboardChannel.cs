using System.Runtime.Versioning;
using System.Security.Cryptography;
using Microsoft.Extensions.Logging;

namespace Wolf.Agent.SessionHost.Clipboard;

/// <summary>What to send the client. Never logged, never written to disk.</summary>
public sealed record ClipboardOffer(string Text);

/// <summary>Why clipboard content was not carried, so the operator is never left guessing.</summary>
public sealed record ClipboardRefusal(string Reason, string Detail);

/// <summary>
/// Clipboard synchronisation between the PC and the viewer.
///
/// Content moves on the WebRTC data channel and never through the cloud. That is a product
/// rule, not an optimisation: **WOLF must never store clipboard contents**, and the surest
/// way to keep a promise about not retaining something is for it never to arrive. Nothing
/// here logs what was copied either — a clipboard routinely holds a password, and lengths
/// and formats are enough to diagnose any problem this class can have.
///
/// Two properties matter more than the plumbing:
///
///  * **It is gated.** `clipboard` is a session capability of its own, decided by the cloud
///    and enforced here. A session that can see a screen has not thereby been given the
///    contents of whatever the person at that machine last copied.
///  * **It does not loop.** Applying content from the client changes the PC's clipboard,
///    which looks exactly like the user copying something. Without remembering what was
///    just applied, the two machines would trade the same text forever.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class ClipboardChannel : IDisposable
{
    /// <summary>How often the clipboard is checked for change.</summary>
    private static readonly TimeSpan PollInterval = TimeSpan.FromMilliseconds(500);

    /// <summary>Matches the protocol's cap. Larger content is refused, never truncated.</summary>
    public const int MaxTextLength = 256 * 1024;

    private readonly string _streamId;
    private readonly Action<ClipboardOffer> _onOffer;
    private readonly Action<string> _onUnsupported;
    private readonly ILogger<ClipboardChannel> _logger;
    private readonly CancellationTokenSource _stopping = new();
    private readonly Thread _thread;
    private readonly object _gate = new();

    private bool _allowed;
    private uint _lastSequence;

    /// <summary>
    /// A hash of the last content that crossed in either direction.
    ///
    /// A hash rather than the text: this object outlives any single exchange, and holding
    /// somebody's clipboard in memory for the life of a stream is not necessary to notice
    /// that nothing has changed.
    /// </summary>
    private byte[]? _lastSeen;

    private long _offered;
    private long _applied;
    private bool _disposed;

    public ClipboardChannel(
        string streamId,
        Action<ClipboardOffer> onOffer,
        Action<string> onUnsupported,
        ILogger<ClipboardChannel> logger)
    {
        _streamId = streamId;
        _onOffer = onOffer;
        _onUnsupported = onUnsupported;
        _logger = logger;

        _thread = new Thread(Run)
        {
            Name = "WOLF clipboard watch",
            IsBackground = true,
        };
    }

    public long TimesOffered => Interlocked.Read(ref _offered);

    public long TimesApplied => Interlocked.Read(ref _applied);

    public bool IsAllowed
    {
        get { lock (_gate) return _allowed; }
    }

    /// <summary>
    /// Begin watching, if this session is allowed to.
    ///
    /// Nothing is read from the clipboard at all until the cloud has said the session holds
    /// the capability — not read and withheld, not read at all.
    /// </summary>
    public void Start(bool allowed)
    {
        lock (_gate)
        {
            _allowed = allowed;

            // Start from where the clipboard is now rather than from zero, so opening a
            // stream does not immediately ship whatever the user last copied without them
            // doing anything.
            _lastSequence = WindowsClipboard.SequenceNumber;
        }

        if (!allowed)
        {
            _logger.LogInformation(
                "Stream {Stream}: clipboard sharing is not permitted for this session.",
                _streamId);
            return;
        }

        _thread.Start();
        _logger.LogInformation("Stream {Stream}: clipboard sharing is active.", _streamId);
    }

    /// <summary>
    /// Put content from the client onto the PC's clipboard.
    ///
    /// Returns null when it worked, or the reason it did not. Every refusal is answered:
    /// somebody who copies on one machine and finds nothing on the other needs to know
    /// whether it was too large, not permitted, or simply failed.
    /// </summary>
    public ClipboardRefusal? Apply(string text)
    {
        lock (_gate)
        {
            if (!_allowed)
            {
                return new ClipboardRefusal(
                    "not-permitted",
                    "This session was not granted permission to use this PC's clipboard.");
            }
        }

        if (text.Length > MaxTextLength)
        {
            return new ClipboardRefusal(
                "too-large",
                $"Clipboard content is limited to {MaxTextLength / 1024} KB of text.");
        }

        if (!WindowsClipboard.TryWriteText(text, _logger))
        {
            return new ClipboardRefusal(
                "failed",
                "Another application is holding this PC's clipboard open.");
        }

        lock (_gate)
        {
            // Remember it before the watcher can notice the change, so the PC does not
            // immediately offer back what the client just sent.
            _lastSeen = Hash(text);
            _lastSequence = WindowsClipboard.SequenceNumber;
        }

        Interlocked.Increment(ref _applied);
        _logger.LogDebug(
            "Stream {Stream}: applied {Length} characters from the client.",
            _streamId,
            text.Length);

        return null;
    }

    private void Run()
    {
        while (!_stopping.IsCancellationRequested)
        {
            try
            {
                Poll();
            }
            catch (Exception ex)
            {
                // Never fatal, and never detailed: whatever failed, the clipboard's contents
                // are not going into a log.
                _logger.LogDebug("Stream {Stream}: a clipboard check failed ({Error}).", _streamId, ex.GetType().Name);
            }

            _stopping.Token.WaitHandle.WaitOne(PollInterval);
        }
    }

    private void Poll()
    {
        uint sequence = WindowsClipboard.SequenceNumber;

        lock (_gate)
        {
            if (!_allowed || sequence == _lastSequence) return;
            _lastSequence = sequence;
        }

        ClipboardKind kind = WindowsClipboard.Inspect();

        if (kind != ClipboardKind.Text)
        {
            if (kind != ClipboardKind.Empty)
            {
                // Named, not carried. An operator who copies a screenshot and finds nothing
                // on the other machine should be told WOLF does not move images, rather than
                // concluding clipboard sync is broken.
                _onUnsupported(kind == ClipboardKind.Image ? "image" : "files");
            }

            return;
        }

        string? text = WindowsClipboard.TryReadText(_logger);
        if (string.IsNullOrEmpty(text)) return;

        if (text.Length > MaxTextLength)
        {
            _logger.LogDebug(
                "Stream {Stream}: the clipboard holds {Length} characters, past the limit.",
                _streamId,
                text.Length);
            return;
        }

        byte[] hash = Hash(text);

        lock (_gate)
        {
            // The client sent this a moment ago, and applying it changed the clipboard.
            // Sending it straight back is how two machines end up trading one string
            // forever.
            if (_lastSeen is not null && hash.AsSpan().SequenceEqual(_lastSeen)) return;
            _lastSeen = hash;
        }

        Interlocked.Increment(ref _offered);
        _logger.LogDebug(
            "Stream {Stream}: offering {Length} characters from the PC.",
            _streamId,
            text.Length);

        _onOffer(new ClipboardOffer(text));
    }

    private static byte[] Hash(string text) => SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(text));

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        _stopping.Cancel();
        if (_thread.IsAlive) _thread.Join(TimeSpan.FromSeconds(1));
        _stopping.Dispose();

        lock (_gate)
        {
            // Nothing about what was copied outlives the stream, not even a hash.
            _lastSeen = null;
        }

        _logger.LogInformation(
            "Stream {Stream}: clipboard sharing ended after {Offered} offered, {Applied} applied.",
            _streamId,
            Interlocked.Read(ref _offered),
            Interlocked.Read(ref _applied));
    }
}
