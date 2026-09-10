using System.IO.Pipes;
using System.Runtime.Versioning;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Wolf.Agent.Core.Ipc;
using Wolf.Agent.SessionHost.Audio;
using Wolf.Agent.SessionHost.Capture;
using Wolf.Agent.SessionHost.Displays;
using Wolf.Agent.SessionHost.Encoding;
using Wolf.Agent.SessionHost.Transport;

namespace Wolf.Agent.SessionHost;

/// <summary>
/// The WOLF session host.
///
/// It runs inside the interactive Windows session, as the signed-in user, because that is
/// the only place a process can see the desktop or send input to it. The agent service
/// launches it and supervises it; this process does the work that session 0 cannot.
///
/// What it does: enumerates the displays attached to this session, discovers which video
/// encoders Media Foundation actually offers, captures and encodes the screen to H.264 on
/// the GPU, captures what the PC is playing and encodes it to Opus, injects keyboard and
/// mouse input, and carries all of it to a remote peer over WebRTC.
///
/// Audio is **loopback** — the sound the PC is producing, not a microphone. Nothing in this
/// process can hear the room the machine is sitting in.
/// </summary>
[SupportedOSPlatform("windows10.0.19041.0")]
public static class Program
{
    private static readonly TimeSpan StatusInterval = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan ReconnectDelay = TimeSpan.FromSeconds(3);

    public static async Task<int> Main()
    {
        using ILoggerFactory loggerFactory = LoggerFactory.Create(builder =>
        {
            builder.AddSimpleConsole(options => options.SingleLine = true);
            builder.AddEventLog(settings => settings.SourceName = "WOLF Session Host");
            builder.SetMinimumLevel(LogLevel.Information);
        });

        ILogger logger = loggerFactory.CreateLogger("Wolf.Agent.SessionHost");

        // Before any display API is touched: a DPI-unaware process is told a scaled monitor
        // is smaller than it is, which would make the reported resolution, the captured
        // frame, and the pointer coordinates three different things.
        if (!DpiAwareness.EnsurePerMonitorAware())
        {
            logger.LogWarning("Per-monitor DPI awareness could not be set for this process.");
        }
        using var shutdown = new CancellationTokenSource();

        Console.CancelKeyPress += (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            shutdown.Cancel();
        };

        var displays = new DisplayEnumerator(loggerFactory.CreateLogger<DisplayEnumerator>());
        var encoders = new EncoderProbe(loggerFactory.CreateLogger<EncoderProbe>());

        logger.LogInformation(
            "WOLF session host starting in session {Session} as {User}.",
            Environment.ProcessId,
            Environment.UserName);

        while (!shutdown.IsCancellationRequested)
        {
            try
            {
                await RunAsync(displays, encoders, loggerFactory, logger, shutdown.Token)
                    .ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (shutdown.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "The session host connection failed; retrying.");
            }

            try
            {
                await Task.Delay(ReconnectDelay, shutdown.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }

        logger.LogInformation("WOLF session host stopped.");
        return 0;
    }

    private static async Task RunAsync(
        DisplayEnumerator displays,
        EncoderProbe encoders,
        ILoggerFactory loggerFactory,
        ILogger logger,
        CancellationToken cancellationToken)
    {
        await using var pipe = new NamedPipeClientStream(
            ".",
            WolfIpc.PipeName,
            PipeDirection.InOut,
            PipeOptions.Asynchronous);

        await pipe.ConnectAsync(cancellationToken).ConfigureAwait(false);
        using var channel = new IpcChannel(pipe);

        IReadOnlyList<IpcDisplay> currentDisplays = displays.Enumerate();
        IReadOnlyList<IpcEncoder> currentEncoders = encoders.Probe();

        // Streams belong to this connection. If the agent service restarts, the pipe drops
        // and every stream on it is torn down — a stream whose signaling path is gone cannot
        // be renegotiated, and leaving it capturing would be a camera nobody is watching.
        using var streams = new StreamCoordinator(
            displays,
            (message, token) => channel.SendAsync(message, token),
            loggerFactory);

        logger.LogInformation(
            "Connected to the WOLF agent: {Displays} display(s), {Encoders} encoder(s).",
            currentDisplays.Count,
            currentEncoders.Count);

        await channel
            .SendAsync(
                new HostHelloMessage(
                    HostVersion: typeof(Program).Assembly.GetName().Version?.ToString(3) ?? "0.0.0",
                    SessionId: Environment.ProcessId,
                    UserName: Environment.UserName,
                    Displays: currentDisplays,
                    Encoders: currentEncoders,
                    CaptureApi: DetectCaptureApi(),
                    AudioCaptureAvailable: DetectAudioCapture(loggerFactory),
                    // WebRTC is present, so frames produced here have somewhere to go. This
                    // stays a separate field from the capture API because the two can fail
                    // independently, and an operator needs to know which one did.
                    TransportAvailable: true),
                cancellationToken)
            .ConfigureAwait(false);

        using var sessionCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        Task statusLoop = SendStatusAsync(channel, displays, streams, sessionCts.Token);

        try
        {
            await foreach (JsonDocument document in channel.ReadAsync(sessionCts.Token).ConfigureAwait(false))
            {
                using (document)
                {
                    if (!IpcChannel.IsSupportedVersion(document))
                    {
                        logger.LogError("The WOLF agent speaks an unsupported IPC version.");
                        return;
                    }

                    await HandleAsync(document, channel, displays, encoders, streams, logger, sessionCts.Token)
                        .ConfigureAwait(false);
                }
            }
        }
        finally
        {
            await sessionCts.CancelAsync().ConfigureAwait(false);
            try
            {
                await statusLoop.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
            }
        }
    }

    /// <summary>
    /// Which capture API this host will use, if any.
    ///
    /// Graphics Capture where it exists, Desktop Duplication where it does not, and "none"
    /// where neither does — the agent supports builds old enough for that to be the honest
    /// answer, and a PC that says it cannot stream is better than one that offers to and
    /// then produces a black screen.
    /// </summary>
    private static string DetectCaptureApi() => DisplayCaptureFactory.DetectApi();

    /// <summary>
    /// Whether this PC has audio WOLF can capture.
    ///
    /// Answered by opening the endpoint and closing it again, not by assuming. A machine
    /// with no audio device — a server, a virtual machine without an audio driver — is a
    /// real configuration, and a capability list that claimed otherwise would offer sound
    /// that never arrives.
    /// </summary>
    private static bool DetectAudioCapture(ILoggerFactory loggers)
    {
        using AudioLoopbackCapture? capture = AudioLoopbackCapture.TryStart(
            loggers.CreateLogger<AudioLoopbackCapture>());

        return capture is not null;
    }

    /// <summary>
    /// Which desktop has the input, in the words the IPC uses.
    ///
    /// Asked every time it is reported rather than cached: the whole point of the answer is
    /// that it changes the moment somebody locks the screen or Windows raises a UAC prompt.
    /// </summary>
    private static string DescribeInputDesktop() => InputDesktop.Query() switch
    {
        InputDesktopState.UserDesktop => IpcInputDesktop.User,
        InputDesktopState.Secure => IpcInputDesktop.Secure,
        _ => IpcInputDesktop.Unknown,
    };

    private static async Task HandleAsync(
        JsonDocument document,
        IpcChannel channel,
        DisplayEnumerator displays,
        EncoderProbe encoders,
        StreamCoordinator streams,
        ILogger logger,
        CancellationToken cancellationToken)
    {
        switch (IpcChannel.KindOf(document))
        {
            case "service.hello-ack":
                logger.LogDebug("The WOLF agent acknowledged the session host.");
                return;

            case "service.refresh":
                // A monitor was plugged in, or the cloud asked for fresh detection.
                await channel
                    .SendAsync(
                        new HostStatusMessage(
                            At: DateTimeOffset.UtcNow.ToString("o"),
                            Displays: displays.Enumerate(),
                            Streams: streams.Describe(),
                            DesktopAccessible: true,
                            InputDesktop: DescribeInputDesktop()),
                        cancellationToken)
                    .ConfigureAwait(false);
                _ = encoders; // Encoder discovery is re-run on reconnect, not per refresh.
                return;

            case "service.signal":
            {
                ServiceSignalMessage? signal = document.Deserialize<ServiceSignalMessage>(WolfIpc.Json);
                if (signal is null)
                {
                    logger.LogWarning("A signaling message could not be read and was dropped.");
                    return;
                }

                await streams.HandleAsync(signal, cancellationToken).ConfigureAwait(false);
                return;
            }

            case "service.action":
            {
                ServiceActionMessage? request = document.Deserialize<ServiceActionMessage>(WolfIpc.Json);
                if (request is null)
                {
                    logger.LogWarning("An action request could not be read and was dropped.");
                    return;
                }

                // Answered whatever happens, including a refusal: the service is waiting on
                // this, and silence would leave a command unanswered until it timed out.
                await channel
                    .SendAsync(SessionActions.Perform(request.RequestId, request.Action, logger), cancellationToken)
                    .ConfigureAwait(false);
                return;
            }

            case "service.stop":
            {
                ServiceStopMessage? stop = document.Deserialize<ServiceStopMessage>(WolfIpc.Json);
                streams.Stop(stop?.StreamId, stop?.Reason ?? "service-requested");
                return;
            }

            default:
                logger.LogDebug("Ignored an unrecognised message from the WOLF agent.");
                return;
        }
    }

    /// <summary>
    /// Report periodically so the service notices a dead host, and so a display change
    /// reaches the dashboard without waiting for a reconnect.
    /// </summary>
    private static async Task SendStatusAsync(
        IpcChannel channel,
        DisplayEnumerator displays,
        StreamCoordinator streams,
        CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(StatusInterval, cancellationToken).ConfigureAwait(false);
                await channel
                    .SendAsync(
                        new HostStatusMessage(
                            At: DateTimeOffset.UtcNow.ToString("o"),
                            Displays: displays.Enumerate(),
                            Streams: streams.Describe(),
                            DesktopAccessible: true,
                            InputDesktop: DescribeInputDesktop()),
                        cancellationToken)
                    .ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch (Exception ex) when (ex is IOException or ObjectDisposedException)
            {
                return; // The pipe closed; the outer loop reconnects.
            }
        }
    }
}
