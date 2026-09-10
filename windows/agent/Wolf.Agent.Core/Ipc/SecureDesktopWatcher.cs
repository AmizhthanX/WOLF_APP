using System.Runtime.Versioning;
using Microsoft.Extensions.Logging;

namespace Wolf.Agent.Core.Ipc;

/// <summary>
/// Shows the operator the lock screen while the secure desktop has the input.
///
/// The whole policy is short, which is the point: the session host says which desktop has the
/// input, and that turns into a host on the secure one existing or not, and into frames going
/// onto the connection the user host already holds. Everything hard is on either side —
/// knowing the desktop, running a process on it, and putting H.264 on a track.
///
/// Two things it will not do:
///
/// **Capture when nobody is watching.** The secure host starts as soon as the screen locks,
/// so the agent knows what it can see, but it is not asked for frames until a stream is
/// actually running. Encoding a lock screen for nobody would be a SYSTEM process burning a
/// GPU on a still picture.
///
/// **Keep the host alive after the unlock.** It holds a duplication of the display and runs
/// as SYSTEM. Two seconds to start beats hours of that.
///
/// **Never run.** Starting the host needs the agent installed as a Windows service, and the
/// screen locked. See <see cref="SecureDesktopSupervisor"/>.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class SecureDesktopWatcher : IAsyncDisposable
{
    /// <summary>
    /// What the secure host is asked to produce.
    ///
    /// Modest on every axis, and deliberately. A lock screen is a still picture: it changes
    /// when somebody touches the keyboard and not otherwise. Full resolution at sixty frames
    /// a second would spend real GPU on re-encoding the same pixels, and the frames cross two
    /// pipes to get where they are going.
    /// </summary>
    private static readonly ServiceSecureCaptureMessage CaptureRequest = new(
        Capture: true,
        MaxWidthPixels: 1920,
        MaxHeightPixels: 1080,
        TargetFps: 10,
        BitrateBps: 2_000_000);

    private static readonly ServiceSecureCaptureMessage StopRequest = new(
        Capture: false,
        MaxWidthPixels: 0,
        MaxHeightPixels: 0,
        TargetFps: 0,
        BitrateBps: 0);

    private readonly SessionHostSupervisor _sessionHost;
    private readonly SecureDesktopSupervisor _secureHost;
    private readonly ILogger<SecureDesktopWatcher> _logger;

    private bool _secureShowing;

    public SecureDesktopWatcher(
        SessionHostSupervisor sessionHost,
        SecureDesktopSupervisor secureHost,
        ILogger<SecureDesktopWatcher> logger)
    {
        _sessionHost = sessionHost;
        _secureHost = secureHost;
        _logger = logger;
    }

    public void Start()
    {
        _sessionHost.InputDesktopChanged += OnInputDesktopChanged;
        _sessionHost.SecureInputForwarded += OnSecureInput;
        _secureHost.FrameReceived += OnFrame;
        _secureHost.StateChanged += OnSecureStateChanged;
    }

    /// <summary>
    /// Carry authorised input to the desktop it was meant for.
    ///
    /// Dropped rather than redirected when the secure desktop is not what the client is
    /// looking at. Input aimed at a lock screen that has just gone would land on the
    /// operator's own desktop, typing a password into whatever has focus.
    /// </summary>
    private void OnSecureInput(HostSecureInputMessage input)
    {
        if (!_secureShowing) return;

        Fire(_secureHost.SendInputAsync(
            new ServiceSecureInputMessage(input.StreamId, input.Batch),
            CancellationToken.None));
    }

    private void OnInputDesktopChanged(string inputDesktop)
    {
        if (inputDesktop == IpcInputDesktop.Secure)
        {
            if (!_secureHost.CanCapture())
            {
                // Said once, at the moment it would have mattered, rather than as a
                // capability nobody read. The reason is the operator's to know: "install
                // WOLF as a service" and "nobody is at the console" call for different things.
                _logger.LogInformation(
                    "The secure desktop has the input but cannot be captured here: {Reason}",
                    _secureHost.WhyNot());
                return;
            }

            _logger.LogInformation("The secure desktop has the input; starting a host on it.");
            _secureHost.Start();
            return;
        }

        // Anything else — the user desktop, or an answer nobody could give. Unknown stops it
        // too: a host on a desktop the agent has lost track of is worse than none, because
        // nothing would be watching whether it was still the right one.
        Fire(StopShowingAsync());
    }

    /// <summary>
    /// The secure host connected, or went away.
    ///
    /// Asking it for frames waits for this rather than happening at launch: until it has said
    /// hello there is no channel to ask on.
    /// </summary>
    private void OnSecureStateChanged(SecureDesktopState state)
    {
        if (state.Connected && _sessionHost.State.ActiveStreams > 0)
        {
            Fire(StartShowingAsync());
            return;
        }

        if (!state.Connected && _secureShowing) Fire(StopShowingAsync());
    }

    private async Task StartShowingAsync()
    {
        if (_secureShowing) return;

        if (!await _secureHost.RequestCaptureAsync(CaptureRequest, CancellationToken.None).ConfigureAwait(false))
        {
            _logger.LogWarning("The secure-desktop host could not be asked for frames.");
            return;
        }

        _secureShowing = true;

        // The user host is told before the frames arrive, so the first one is not dropped for
        // belonging to a desktop it does not yet know it is showing.
        await _sessionHost
            .SendAsync(new ServiceSecureStateMessage(true, "the screen is locked"), CancellationToken.None)
            .ConfigureAwait(false);

        _logger.LogInformation("The client is now being shown the secure desktop.");
    }

    private async Task StopShowingAsync()
    {
        if (_secureShowing)
        {
            _secureShowing = false;

            await _sessionHost
                .SendAsync(new ServiceSecureStateMessage(false, null), CancellationToken.None)
                .ConfigureAwait(false);

            // Best effort: the host is about to be killed anyway, and if the pipe has already
            // gone there is nothing to stop.
            await _secureHost.RequestCaptureAsync(StopRequest, CancellationToken.None).ConfigureAwait(false);
        }

        await _secureHost.StopAsync().ConfigureAwait(false);
    }

    /// <summary>
    /// Hand one frame of the secure desktop to the host that has the connection.
    ///
    /// Fire-and-forget, on the pipe's read loop. Waiting here would pace the secure host's
    /// encoder to whatever the user host is doing, and a slow reader would show up as a
    /// stuttering lock screen rather than as the dropped frame it is.
    /// </summary>
    private void OnFrame(HostFrameMessage frame)
    {
        if (!_secureShowing) return;

        Fire(_sessionHost.SendAsync(
            new ServiceSecureFrameMessage(frame.Data, frame.KeyFrame, frame.WidthPixels, frame.HeightPixels),
            CancellationToken.None));
    }

    /// <summary>
    /// Run something nobody is waiting on, without losing its failures.
    ///
    /// Called from pipe read loops, which must not block on a process being killed or a
    /// frame crossing another pipe.
    /// </summary>
    private void Fire(Task work) => _ = work.ContinueWith(
        task =>
        {
            if (task.Exception is { } error)
            {
                _logger.LogError(error, "A secure-desktop hand-off failed.");
            }
        },
        TaskScheduler.Default);

    public async ValueTask DisposeAsync()
    {
        _sessionHost.InputDesktopChanged -= OnInputDesktopChanged;
        _sessionHost.SecureInputForwarded -= OnSecureInput;
        _secureHost.FrameReceived -= OnFrame;
        _secureHost.StateChanged -= OnSecureStateChanged;

        await _secureHost.StopAsync().ConfigureAwait(false);
    }
}
