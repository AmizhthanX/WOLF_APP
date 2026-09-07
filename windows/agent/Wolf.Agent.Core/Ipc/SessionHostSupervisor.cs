using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Wolf.Agent.Core.Native;

namespace Wolf.Agent.Core.Ipc;

/// <summary>What the service currently knows about the session host. </summary>
public sealed record SessionHostState
{
    public bool Connected { get; init; }
    public int? WindowsSessionId { get; init; }
    public string? UserName { get; init; }
    public string? HostVersion { get; init; }
    public IReadOnlyList<IpcDisplay> Displays { get; init; } = Array.Empty<IpcDisplay>();
    public IReadOnlyList<IpcEncoder> Encoders { get; init; } = Array.Empty<IpcEncoder>();
    public string CaptureApi { get; init; } = "none";
    public bool AudioCaptureAvailable { get; init; }
    /// <summary>True when the host can actually deliver frames to a remote peer.</summary>
    public bool TransportAvailable { get; init; }
    public bool DesktopAccessible { get; init; }

    /// <summary>Streams running in the interactive session right now.</summary>
    public IReadOnlyList<IpcStreamStatus> Streams { get; init; } = Array.Empty<IpcStreamStatus>();

    public int ActiveStreams => Streams.Count;
    /// <summary>Why there is no host, when there is none. Shown to the operator verbatim. </summary>
    public string? UnavailableReason { get; init; }
    public DateTimeOffset UpdatedAt { get; init; } = DateTimeOffset.UtcNow;
}

/// <summary>
/// Runs and supervises the session host.
///
/// The agent service lives in session 0, where there is no desktop: it cannot capture the
/// screen or inject input. The session host does both, from inside the interactive session,
/// launched as the signed-in user so it holds no more privilege than the person sitting at
/// the machine.
///
/// This class owns the awkward part — noticing when a session appears or disappears,
/// launching the host into it, and keeping an authenticated channel open — so the rest of
/// the agent can simply ask "can this PC stream right now, and with what".
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class SessionHostSupervisor : IAsyncDisposable
{
    private const string HostExecutableName = "Wolf.Agent.SessionHost.exe";
    private static readonly TimeSpan ConnectTimeout = TimeSpan.FromSeconds(20);

    private readonly ILogger<SessionHostSupervisor> _logger;
    private readonly string _hostPath;
    private readonly object _stateGate = new();

    private SessionHostState _state = new() { UnavailableReason = "The session host has not started yet." };
    private IpcChannel? _channel;
    private Process? _hostProcess;
    private CancellationTokenSource? _running;
    private Task? _loop;

    /// <summary>Raised when a signaling message arrives from the host. </summary>
    public event Func<HostSignalMessage, Task>? SignalReceived;

    public SessionHostSupervisor(ILogger<SessionHostSupervisor> logger, string? hostPath = null)
    {
        _logger = logger;
        _hostPath = hostPath ?? Path.Combine(AppContext.BaseDirectory, HostExecutableName);
    }

    public SessionHostState State
    {
        get
        {
            lock (_stateGate)
            {
                return _state;
            }
        }
    }

    private void UpdateState(Func<SessionHostState, SessionHostState> update)
    {
        lock (_stateGate)
        {
            _state = update(_state) with { UpdatedAt = DateTimeOffset.UtcNow };
        }
    }

    public void Start()
    {
        if (_loop is not null) return;
        _running = new CancellationTokenSource();
        _loop = Task.Run(() => SuperviseAsync(_running.Token));
    }

    /// <summary>
    /// Keep a host running for whichever session is at the console.
    ///
    /// Every failure here is normal at some point in a machine's day: nobody is signed in,
    /// the lock screen is up, the user is switching accounts. None of them are errors, so
    /// the loop reports the reason and waits rather than logging noise.
    /// </summary>
    private async Task SuperviseAsync(CancellationToken cancellationToken)
    {
        var backoff = TimeSpan.FromSeconds(2);

        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                bool served = await RunHostAsync(cancellationToken).ConfigureAwait(false);
                backoff = served ? TimeSpan.FromSeconds(2) : NextBackoff(backoff);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "The session host supervisor failed; retrying.");
                UpdateState(state => state with
                {
                    Connected = false,
                    UnavailableReason = "The session host could not be started.",
                });
                backoff = NextBackoff(backoff);
            }

            try
            {
                await Task.Delay(backoff, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    private static TimeSpan NextBackoff(TimeSpan current) =>
        TimeSpan.FromSeconds(Math.Min(current.TotalSeconds * 2, 30));

    /// <summary>Launch a host and serve its channel. Returns true when a host actually ran.</summary>
    private async Task<bool> RunHostAsync(CancellationToken cancellationToken)
    {
        uint sessionId = NativeMethods.WTSGetActiveConsoleSessionId();
        if (sessionId == 0xFFFFFFFF)
        {
            UpdateState(state => state with
            {
                Connected = false,
                WindowsSessionId = null,
                UnavailableReason = "No interactive session is attached to the console.",
            });
            return false;
        }

        if (!File.Exists(_hostPath))
        {
            UpdateState(state => state with
            {
                Connected = false,
                UnavailableReason =
                    "The WOLF session host is not installed, so this PC cannot stream its screen.",
            });
            _logger.LogWarning("Session host executable not found at {Path}.", _hostPath);
            return false;
        }

        SecurityIdentifier? userSid = null;
        IntPtr userToken = IntPtr.Zero;

        // A service running as SYSTEM can obtain the signed-in user's token. Running
        // interactively (development, or the control panel) it cannot, and does not need
        // to: the host can simply be started as a child in the same session.
        bool asService = !Environment.UserInteractive;
        if (asService)
        {
            if (!SessionNativeMethods.WTSQueryUserToken(sessionId, out userToken))
            {
                int error = Marshal.GetLastWin32Error();
                UpdateState(state => state with
                {
                    Connected = false,
                    WindowsSessionId = (int)sessionId,
                    UnavailableReason =
                        "Nobody is signed in at the console, so there is no desktop to capture.",
                });
                _logger.LogDebug("WTSQueryUserToken failed for session {Session} (error {Error}).", sessionId, error);
                return false;
            }

            try
            {
                using var identity = new WindowsIdentity(userToken);
                userSid = identity.User;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Could not read the identity of the signed-in user.");
            }
        }

        try
        {
            using NamedPipeServerStream pipe = CreatePipe(userSid);
            Process? host = asService
                ? LaunchAsUser(userToken, sessionId)
                : LaunchInProcessSession();

            if (host is null)
            {
                UpdateState(state => state with
                {
                    Connected = false,
                    UnavailableReason = "The WOLF session host could not be launched.",
                });
                return false;
            }

            _hostProcess = host;

            using var connectCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            connectCts.CancelAfter(ConnectTimeout);

            try
            {
                await pipe.WaitForConnectionAsync(connectCts.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                _logger.LogWarning("The session host did not connect within the timeout.");
                KillHost();
                return false;
            }

            await ServeAsync(pipe, (int)sessionId, cancellationToken).ConfigureAwait(false);
            return true;
        }
        finally
        {
            if (userToken != IntPtr.Zero) SessionNativeMethods.CloseHandle(userToken);
            KillHost();
        }
    }

    /// <summary>
    /// Create the control pipe, reachable only by SYSTEM and the user the host runs as.
    ///
    /// Without this ACL, any local user could connect and drive the capture pipeline of
    /// whoever happens to be signed in.
    /// </summary>
    private static NamedPipeServerStream CreatePipe(SecurityIdentifier? userSid)
    {
        var security = new PipeSecurity();

        var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
        security.AddAccessRule(
            new PipeAccessRule(system, PipeAccessRights.FullControl, AccessControlType.Allow));

        var administrators = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
        security.AddAccessRule(
            new PipeAccessRule(administrators, PipeAccessRights.FullControl, AccessControlType.Allow));

        if (userSid is not null)
        {
            security.AddAccessRule(
                new PipeAccessRule(
                    userSid,
                    PipeAccessRights.ReadWrite | PipeAccessRights.Synchronize,
                    AccessControlType.Allow));
        }
        else
        {
            // Interactive fallback: the host runs as the same user as this process.
            security.AddAccessRule(
                new PipeAccessRule(
                    WindowsIdentity.GetCurrent().User!,
                    PipeAccessRights.ReadWrite | PipeAccessRights.Synchronize,
                    AccessControlType.Allow));
        }

        return NamedPipeServerStreamAcl.Create(
            WolfIpc.PipeName,
            PipeDirection.InOut,
            maxNumberOfServerInstances: 1,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous,
            inBufferSize: 64 * 1024,
            outBufferSize: 64 * 1024,
            security);
    }

    /// <summary>Launch the host into the interactive session, as the signed-in user.</summary>
    private Process? LaunchAsUser(IntPtr userToken, uint sessionId)
    {
        IntPtr primaryToken = IntPtr.Zero;
        IntPtr environment = IntPtr.Zero;

        try
        {
            if (!SessionNativeMethods.DuplicateTokenEx(
                    userToken,
                    SessionNativeMethods.MaximumAllowed,
                    IntPtr.Zero,
                    SessionNativeMethods.SecurityImpersonationLevel.SecurityIdentification,
                    SessionNativeMethods.TokenType.TokenPrimary,
                    out primaryToken))
            {
                _logger.LogError(
                    "Could not duplicate the user token (error {Error}).",
                    Marshal.GetLastWin32Error());
                return null;
            }

            if (!SessionNativeMethods.CreateEnvironmentBlock(out environment, primaryToken, false))
            {
                _logger.LogWarning(
                    "Could not build the user environment block (error {Error}); continuing without it.",
                    Marshal.GetLastWin32Error());
                environment = IntPtr.Zero;
            }

            var startup = new SessionNativeMethods.StartupInfo
            {
                cb = Marshal.SizeOf<SessionNativeMethods.StartupInfo>(),
                // Naming the desktop explicitly is what gives the host a window station to
                // capture; without it the process starts with no desktop at all.
                lpDesktop = @"winsta0\default",
            };

            uint flags = SessionNativeMethods.CreateNoWindow;
            if (environment != IntPtr.Zero)
            {
                flags |= SessionNativeMethods.CreateUnicodeEnvironment;
            }

            if (!SessionNativeMethods.CreateProcessAsUser(
                    primaryToken,
                    _hostPath,
                    null,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    false,
                    flags,
                    environment,
                    Path.GetDirectoryName(_hostPath),
                    ref startup,
                    out SessionNativeMethods.ProcessInformation info))
            {
                _logger.LogError(
                    "Could not start the session host in session {Session} (error {Error}).",
                    sessionId,
                    Marshal.GetLastWin32Error());
                return null;
            }

            SessionNativeMethods.CloseHandle(info.hThread);
            SessionNativeMethods.CloseHandle(info.hProcess);

            _logger.LogInformation(
                "Started the WOLF session host in session {Session} as process {Pid}.",
                sessionId,
                info.dwProcessId);

            try
            {
                return Process.GetProcessById(info.dwProcessId);
            }
            catch (ArgumentException)
            {
                // It exited immediately; the pipe wait will time out and report it.
                return null;
            }
        }
        finally
        {
            if (environment != IntPtr.Zero) SessionNativeMethods.DestroyEnvironmentBlock(environment);
            if (primaryToken != IntPtr.Zero) SessionNativeMethods.CloseHandle(primaryToken);
        }
    }

    /// <summary>
    /// Development path: the agent is already running interactively, so the host can be an
    /// ordinary child process. Marked distinctly in the log so nobody mistakes a developer
    /// run for the way this works in production.
    /// </summary>
    private Process? LaunchInProcessSession()
    {
        _logger.LogInformation(
            "Starting the session host as a child process (agent is running interactively).");

        return Process.Start(new ProcessStartInfo(_hostPath)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = Path.GetDirectoryName(_hostPath)!,
        });
    }

    // -------------------------------------------------------------------------
    // Channel
    // -------------------------------------------------------------------------

    private async Task ServeAsync(
        NamedPipeServerStream pipe,
        int sessionId,
        CancellationToken cancellationToken)
    {
        var channel = new IpcChannel(pipe);
        _channel = channel;

        try
        {
            await foreach (JsonDocument document in channel.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                using (document)
                {
                    if (!IpcChannel.IsSupportedVersion(document))
                    {
                        _logger.LogError("The session host speaks an unsupported IPC version.");
                        return;
                    }

                    await HandleAsync(document, sessionId, channel, cancellationToken).ConfigureAwait(false);
                }
            }
        }
        catch (InvalidOperationException ex)
        {
            _logger.LogError(ex, "The session host sent a malformed message; restarting it.");
        }
        finally
        {
            _channel = null;
            UpdateState(state => state with
            {
                Connected = false,
                UnavailableReason = "The session host disconnected.",

                // The host died and took its streams with it. Reporting them as still
                // running would have the dashboard offer to stop something that is gone.
                Streams = Array.Empty<IpcStreamStatus>(),
            });
            channel.Dispose();
        }
    }

    private async Task HandleAsync(
        JsonDocument document,
        int sessionId,
        IpcChannel channel,
        CancellationToken cancellationToken)
    {
        switch (IpcChannel.KindOf(document))
        {
            case "host.hello":
            {
                HostHelloMessage? hello = document.Deserialize<HostHelloMessage>(WolfIpc.Json);
                if (hello is null) return;

                UpdateState(_ => new SessionHostState
                {
                    Connected = true,
                    WindowsSessionId = sessionId,
                    UserName = hello.UserName,
                    HostVersion = hello.HostVersion,
                    Displays = hello.Displays,
                    Encoders = hello.Encoders,
                    CaptureApi = hello.CaptureApi,
                    AudioCaptureAvailable = hello.AudioCaptureAvailable,
                    TransportAvailable = hello.TransportAvailable,
                    DesktopAccessible = true,
                    UnavailableReason = null,
                });

                _logger.LogInformation(
                    "Session host connected: {Displays} display(s), {Encoders} encoder(s), " +
                    "capture via {Api}, transport {Transport}.",
                    hello.Displays.Count,
                    hello.Encoders.Count,
                    hello.CaptureApi,
                    hello.TransportAvailable ? "available" : "unavailable");

                await channel
                    .SendAsync(new ServiceHelloAckMessage("0.1.0", 15), cancellationToken)
                    .ConfigureAwait(false);
                return;
            }

            case "host.status":
            {
                HostStatusMessage? status = document.Deserialize<HostStatusMessage>(WolfIpc.Json);
                if (status is null) return;

                UpdateState(state => state with
                {
                    Displays = status.Displays,
                    Streams = status.Streams,
                    DesktopAccessible = status.DesktopAccessible,
                });
                return;
            }

            case "host.signal":
            {
                HostSignalMessage? signal = document.Deserialize<HostSignalMessage>(WolfIpc.Json);
                if (signal is null) return;

                Func<HostSignalMessage, Task>? handler = SignalReceived;
                if (handler is not null)
                {
                    await handler(signal).ConfigureAwait(false);
                }
                return;
            }

            case "host.error":
            {
                HostErrorMessage? error = document.Deserialize<HostErrorMessage>(WolfIpc.Json);
                if (error is null) return;

                _logger.LogWarning(
                    "Session host reported {Code} for stream {Stream}: {Message}",
                    error.Code,
                    error.StreamId ?? "(none)",
                    error.Message);
                return;
            }

            default:
                _logger.LogDebug("Ignored an unrecognised session host message.");
                return;
        }
    }

    /// <summary>Send a message to the host. Returns false when there is no host connected. </summary>
    public async Task<bool> SendAsync<T>(T message, CancellationToken cancellationToken)
    {
        IpcChannel? channel = _channel;
        if (channel is null) return false;

        try
        {
            await channel.SendAsync(message, cancellationToken).ConfigureAwait(false);
            return true;
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException or InvalidOperationException)
        {
            _logger.LogWarning("Could not reach the session host; it will be restarted.");
            return false;
        }
    }

    private void KillHost()
    {
        Process? host = _hostProcess;
        _hostProcess = null;
        if (host is null) return;

        try
        {
            if (!host.HasExited) host.Kill(entireProcessTree: true);
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            // Already gone.
        }
        finally
        {
            host.Dispose();
        }
    }

    public async ValueTask DisposeAsync()
    {
        _running?.Cancel();

        if (_loop is not null)
        {
            try
            {
                await _loop.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
            }
        }

        _running?.Dispose();
        _channel?.Dispose();
        KillHost();
    }
}
