using System.Runtime.Versioning;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Wolf.Agent.Core.Ipc;
using Wolf.Agent.SessionHost.Displays;
using Wolf.Agent.SessionHost.Input;

namespace Wolf.Agent.SessionHost;

/// <summary>
/// Injects input on the secure desktop.
///
/// This is what makes a lock screen worth seeing. The operator watches their own PC's lock
/// screen and signs in to it — typing their password themselves, as keystrokes on an
/// encrypted stream. WOLF never stores it, never logs it, and has no idea which of the
/// keystrokes it was.
///
/// That is a different claim from "WOLF can unlock your PC", and the difference is the point:
/// there is no Windows mechanism that unlocks a session without credentials, and the ones
/// that avoid the *password* need a DLL inside `lsass` that Windows will not load unsigned.
/// See [remote unlock](../../../docs/architecture/remote-unlock.md).
///
/// **Authorisation happened before any of this.** The user host holds the session, the
/// control lease and its expiry, and checked all of it before forwarding. This class injects
/// what the service hands it, on a pipe only SYSTEM can open. It is deliberately incapable of
/// deciding whether input is allowed, because it has nothing to decide with.
///
/// **Never run**, like the rest of the secure-desktop path.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class SecureInputSink
{
    private readonly DisplayEnumerator _displays;
    private readonly ILoggerFactory _loggers;
    private readonly ILogger<SecureInputSink> _logger;
    private readonly object _gate = new();

    private InputChannel? _channel;
    private string? _streamId;
    private long _batches;

    public SecureInputSink(DisplayEnumerator displays, ILoggerFactory loggers)
    {
        _displays = displays;
        _loggers = loggers;
        _logger = loggers.CreateLogger<SecureInputSink>();
    }

    /// <summary>Batches injected on the secure desktop since this host started.</summary>
    public long Batches => Interlocked.Read(ref _batches);

    /// <summary>
    /// Inject one already-authorised batch.
    ///
    /// The channel is built on first use and reused: it is per-stream, and a lock screen has
    /// one operator on it. A batch for a different stream builds a new one rather than being
    /// injected through the wrong coordinate mapping.
    /// </summary>
    public void Inject(string streamId, JsonElement batch)
    {
        InputChannel channel;

        lock (_gate)
        {
            if (_channel is null || _streamId != streamId)
            {
                IReadOnlyList<IpcDisplay> attached = _displays.Enumerate();
                IpcDisplay? display = attached.FirstOrDefault(candidate => candidate.Primary)
                    ?? (attached.Count > 0 ? attached[0] : null);

                if (display is null)
                {
                    _logger.LogWarning("No display on the secure desktop; input cannot be placed.");
                    return;
                }

                var injector = new InputInjector(display, _loggers.CreateLogger<InputInjector>());
                _channel = new InputChannel(streamId, injector, _loggers.CreateLogger<InputChannel>());

                // The lease was checked by the host that has the session. This channel is
                // told it holds control so its own check passes; it has no way to make that
                // decision itself and must not pretend to.
                _channel.ApplyControl(true, streamId, DateTimeOffset.MaxValue);

                _streamId = streamId;
            }

            channel = _channel;
        }

        InputRejection? rejection = channel.Handle(batch);
        Interlocked.Increment(ref _batches);

        if (rejection is not null)
        {
            // Bounds, not permission: the batch was authorised, so a refusal here means the
            // events themselves were outside what the protocol allows. Logged by code, never
            // by content — one of these keystrokes is somebody's password.
            _logger.LogWarning(
                "A secure-desktop input batch was refused ({Code}): {Reason}",
                rejection.Outcome,
                rejection.Reason);
        }
    }
}
