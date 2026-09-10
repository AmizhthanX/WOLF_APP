using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Wolf.Agent.Core.Native;

namespace Wolf.Agent.Core.Ipc;

/// <summary>What the service knows about the secure-desktop host.</summary>
public sealed record SecureDesktopState
{
    public bool Connected { get; init; }

    /// <summary>Displays the secure host can see, which is the lock screen's layout.</summary>
    public IReadOnlyList<IpcDisplay> Displays { get; init; } = Array.Empty<IpcDisplay>();

    /// <summary>Which capture API it managed to start there.</summary>
    public string CaptureApi { get; init; } = "none";

    /// <summary>Why there is no secure host, when there is none. Shown to the operator verbatim.</summary>
    public string? UnavailableReason { get; init; }

    /// <summary>Machine-readable form of the same, for deciding what to do about it.</summary>
    public string? UnavailableCode { get; init; }

    public DateTimeOffset UpdatedAt { get; init; } = DateTimeOffset.UtcNow;
}

/// <summary>
/// Runs and supervises the host that sits on the secure desktop.
///
/// A second session host, started only while the lock or sign-in screen has the input, on
/// the one desktop the ordinary host cannot see. It exists so a locked PC shows the operator
/// its lock screen instead of a frozen picture and a `LOCKED` badge.
///
/// It is deliberately a separate supervisor rather than a mode of the existing one. The two
/// hosts have different lifetimes — the user host lives as long as the session, this one
/// lives as long as the secure desktop is up — different tokens, different desktops, and
/// different pipes. Folding them together would produce one class with two of everything and
/// a flag deciding which half is real.
///
/// **This has never run.** Starting it needs the agent installed as a Windows service, so
/// that it is SYSTEM, and a machine whose screen is locked while somebody watches. Neither
/// was available where it was written. What that means in practice: every failure is reported
/// with a distinct code and a sentence, because the first person to run this will be reading
/// them to find out which assumption was wrong.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class SecureDesktopSupervisor : IAsyncDisposable
{
    /// <summary>Its own pipe. The user host's is ACL'd to the user and this one must not be.</summary>
    public const string PipeName = "WOLF.Agent.SecureDesktopHost";

    /// <summary>Told to the host on the command line, so it knows which desktop it is on.</summary>
    public const string SecureModeArgument = "--secure-desktop";

    private const string HostExecutableName = "Wolf.Agent.SessionHost.exe";

    /// <summary>
    /// How long to wait for the host to connect back after being launched.
    ///
    /// Generous. It starts on a desktop that is busy drawing a lock screen, and giving up
    /// early would leave a machine reporting that it cannot capture something it can.
    /// </summary>
    private static readonly TimeSpan ConnectTimeout = TimeSpan.FromSeconds(20);

    private readonly ILogger<SecureDesktopSupervisor> _logger;
    private readonly string _hostPath;
    private readonly object _stateGate = new();

    private SecureDesktopState _state = new()
    {
        UnavailableReason = "The secure desktop is not being captured.",
        UnavailableCode = "not-running",
    };

    private CancellationTokenSource? _running;
    private Task? _loop;
    private Process? _hostProcess;
    private IpcChannel? _channel;

    /// <summary>Raised when the secure host reports a captured frame's worth of state.</summary>
    public event Action<SecureDesktopState>? StateChanged;

    /// <summary>
    /// Raised for each encoded frame of the secure desktop.
    ///
    /// Synchronous on the read loop. The consumer forwards it to the user host over a pipe,
    /// and queueing here would add a buffer whose only job is to hide that the pipe is slow.
    /// </summary>
    public event Action<HostFrameMessage>? FrameReceived;

    public SecureDesktopSupervisor(ILogger<SecureDesktopSupervisor> logger, string? hostPath = null)
    {
        _logger = logger;
        _hostPath = hostPath ?? Path.Combine(AppContext.BaseDirectory, HostExecutableName);
    }

    public SecureDesktopState State
    {
        get
        {
            lock (_stateGate) return _state;
        }
    }

    /// <summary>
    /// Whether this PC could capture its secure desktop, without trying.
    ///
    /// What the capability handshake reports. It answers "is this possible here", which is
    /// not "has it worked" — a machine that passes can still fail to launch, and that is
    /// reported when it happens rather than pre-emptively.
    /// </summary>
    public bool CanCapture() => SecureDesktopLaunch.CheckPreconditions(_hostPath) is null;

    /// <summary>Why it could not, for the operator. Null when it could.</summary>
    public string? WhyNot() => SecureDesktopLaunch.CheckPreconditions(_hostPath)?.Message;

    /// <summary>
    /// Ask the secure host to start or stop producing frames.
    ///
    /// Separate from starting the host itself: it connects as soon as the screen locks so the
    /// agent knows what it can see, and captures only once somebody is actually watching.
    /// Encoding a lock screen nobody is looking at would be a SYSTEM process burning a GPU
    /// for nothing.
    /// </summary>
    public async Task<bool> RequestCaptureAsync(
        ServiceSecureCaptureMessage request,
        CancellationToken cancellationToken)
    {
        IpcChannel? channel = _channel;
        if (channel is null) return false;

        try
        {
            await channel.SendAsync(request, cancellationToken).ConfigureAwait(false);
            return true;
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException or InvalidOperationException)
        {
            _logger.LogWarning("Could not reach the secure-desktop host; it will be restarted.");
            return false;
        }
    }

    /// <summary>
    /// Hand an authorised input batch to the host on the secure desktop.
    ///
    /// Returns false when there is no host to hand it to, which is the ordinary case the
    /// instant a screen unlocks: input in flight arrives after the desktop it was meant for
    /// has gone, and is dropped rather than injected somewhere else.
    /// </summary>
    public async Task<bool> SendInputAsync(
        ServiceSecureInputMessage input,
        CancellationToken cancellationToken)
    {
        IpcChannel? channel = _channel;
        if (channel is null) return false;

        try
        {
            await channel.SendAsync(input, cancellationToken).ConfigureAwait(false);
            return true;
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException or InvalidOperationException)
        {
            _logger.LogWarning("Input for the secure desktop could not be delivered; the host has gone.");
            return false;
        }
    }

    /// <summary>
    /// Start capturing the secure desktop, if it is not already.
    ///
    /// Idempotent: called every time the input desktop is observed to be secure, which is on
    /// every status report while the screen is locked.
    /// </summary>
    public void Start()
    {
        if (_loop is not null) return;

        _running = new CancellationTokenSource();
        _loop = Task.Run(() => SuperviseAsync(_running.Token));
    }

    /// <summary>
    /// Stop capturing, because the secure desktop no longer has the input.
    ///
    /// The host is killed rather than asked to leave. It has no state worth flushing, it
    /// holds a duplication of the display, and the screen it was watching has gone.
    /// </summary>
    public async Task StopAsync()
    {
        if (_loop is null) return;

        _running?.Cancel();

        try
        {
            await _loop.ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
        }

        _running?.Dispose();
        _running = null;
        _loop = null;

        KillHost();

        UpdateState(_ => new SecureDesktopState
        {
            UnavailableReason = "The secure desktop is not being captured.",
            UnavailableCode = "not-running",
        });
    }

    private async Task SuperviseAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                await RunOnceAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "The secure-desktop host failed; retrying.");

                UpdateState(_ => new SecureDesktopState
                {
                    UnavailableReason = "The secure-desktop host stopped unexpectedly.",
                    UnavailableCode = "host-failed",
                });
            }

            try
            {
                // Not a backoff that grows. While the lock screen is up this should be
                // running, and a slow retry would mean an operator staring at nothing for
                // longer each time something transient went wrong.
                await Task.Delay(TimeSpan.FromSeconds(2), cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    private async Task RunOnceAsync(CancellationToken cancellationToken)
    {
        using NamedPipeServerStream pipe = CreatePipe();

        (Process? host, SecureLaunchFailure? failure) = SecureDesktopLaunch.TryStart(
            _hostPath,
            SecureModeArgument,
            _logger);

        if (failure is not null)
        {
            UpdateState(_ => new SecureDesktopState
            {
                UnavailableReason = failure.Message,
                UnavailableCode = failure.Code,
            });

            // Not a loop-ending error. The preconditions can change under us — somebody signs
            // in at the console, the service is restarted properly — and the supervisor is
            // stopped when the desktop unlocks rather than when a launch fails.
            return;
        }

        _hostProcess = host;

        try
        {
            using var connecting = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            connecting.CancelAfter(ConnectTimeout);
            await pipe.WaitForConnectionAsync(connecting.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            KillHost();

            UpdateState(_ => new SecureDesktopState
            {
                UnavailableReason =
                    "The secure-desktop host started but never connected back. It may have been " +
                    "unable to open the Winlogon desktop.",
                UnavailableCode = "no-connection",
            });
            return;
        }

        // This channel carries encoded frames as well as control messages.
        var channel = new IpcChannel(pipe, IpcChannel.MaxFrameMessageBytes);
        _channel = channel;

        try
        {
            await foreach (JsonDocument document in channel.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                using (document)
                {
                    Handle(document);
                }
            }
        }
        finally
        {
            _channel = null;
            channel.Dispose();
            KillHost();

            UpdateState(state => state with
            {
                Connected = false,
                UnavailableReason = "The secure-desktop host disconnected.",
                UnavailableCode = "disconnected",
            });
        }
    }

    private void Handle(JsonDocument document)
    {
        switch (IpcChannel.KindOf(document))
        {
            case "host.hello":
            {
                HostHelloMessage? hello = document.Deserialize<HostHelloMessage>(WolfIpc.Json);
                if (hello is null) return;

                _logger.LogInformation(
                    "Secure-desktop host connected: {Displays} display(s), capture via {Api}.",
                    hello.Displays.Count,
                    hello.CaptureApi);

                UpdateState(_ => new SecureDesktopState
                {
                    Connected = true,
                    Displays = hello.Displays,
                    CaptureApi = hello.CaptureApi,
                    UnavailableReason = null,
                    UnavailableCode = null,
                });
                return;
            }

            case "host.status":
            {
                HostStatusMessage? status = document.Deserialize<HostStatusMessage>(WolfIpc.Json);
                if (status is null) return;

                UpdateState(state => state with { Displays = status.Displays });
                return;
            }

            case "host.frame":
            {
                HostFrameMessage? frame = document.Deserialize<HostFrameMessage>(WolfIpc.Json);
                if (frame is null) return;

                FrameReceived?.Invoke(frame);
                return;
            }

            case "host.error":
            {
                HostErrorMessage? error = document.Deserialize<HostErrorMessage>(WolfIpc.Json);
                if (error is null) return;

                // The host is on the desktop and knows why it cannot capture it. That answer
                // is far better than anything the service could infer, so it is kept verbatim.
                _logger.LogWarning("The secure-desktop host reported {Code}: {Message}", error.Code, error.Message);

                UpdateState(state => state with
                {
                    UnavailableReason = error.Message,
                    UnavailableCode = error.Code,
                });
                return;
            }

            default:
                return;
        }
    }

    private void UpdateState(Func<SecureDesktopState, SecureDesktopState> update)
    {
        SecureDesktopState updated;

        lock (_stateGate)
        {
            _state = update(_state) with { UpdatedAt = DateTimeOffset.UtcNow };
            updated = _state;
        }

        StateChanged?.Invoke(updated);
    }

    private void KillHost()
    {
        Process? host = _hostProcess;
        _hostProcess = null;
        if (host is null) return;

        try
        {
            if (!host.HasExited)
            {
                host.Kill(entireProcessTree: true);
            }
            else
            {
                _logger.LogInformation("The secure-desktop host exited with code {Code}.", host.ExitCode);
            }
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            // Already gone, or gone while being asked. Either way there is nothing to kill.
        }
        finally
        {
            host.Dispose();
        }
    }

    /// <summary>
    /// The pipe the secure host connects back on.
    ///
    /// SYSTEM only — unlike the user host's pipe, which also admits the interactive user. The
    /// process on the other end of this one runs as SYSTEM, and the signed-in user has no
    /// business reaching a channel that carries the lock screen.
    /// </summary>
    private static NamedPipeServerStream CreatePipe()
    {
        var security = new PipeSecurity();

        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
            PipeAccessRights.FullControl,
            AccessControlType.Allow));

        return NamedPipeServerStreamAcl.Create(
            PipeName,
            PipeDirection.InOut,
            maxNumberOfServerInstances: 1,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous,
            inBufferSize: 64 * 1024,
            outBufferSize: 64 * 1024,
            security);
    }

    public async ValueTask DisposeAsync()
    {
        await StopAsync().ConfigureAwait(false);
    }
}
