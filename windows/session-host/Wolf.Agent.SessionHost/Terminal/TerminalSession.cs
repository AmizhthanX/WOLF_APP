using System.Runtime.Versioning;
using Microsoft.Extensions.Logging;

namespace Wolf.Agent.SessionHost.Terminal;

/// <summary>One chunk of whatever the shell printed, in order.</summary>
public sealed record TerminalChunk(string TerminalId, long Sequence, string Data);

/// <summary>
/// One shell, running, with its output going somewhere.
///
/// The pseudo console is the mechanism; this is the lifetime. It owns the read loop, numbers
/// the output so a client can notice a gap rather than render a corrupted screen, and makes
/// sure that a shell which exits on its own is reported exactly once — whether it exited
/// because somebody typed `exit`, because it was closed, or because the stream carrying it
/// went away.
///
/// **Nothing here is logged but counts.** The bytes moving through this class are the
/// contents of somebody's terminal: a connection string echoed by a script, a token in an
/// environment dump, a password typed into a prompt that was not hiding it. WOLF does not
/// store them, does not send them through the cloud, and does not write them anywhere a log
/// collector would find them.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class TerminalSession : IDisposable
{
    /// <summary>
    /// How much output is read at a time.
    ///
    /// Below the protocol's per-message cap, so a full buffer is always sendable without
    /// being split again further down.
    /// </summary>
    private const int ReadBufferBytes = 16 * 1024;

    private readonly PseudoConsole _console;
    private readonly Action<TerminalChunk> _onOutput;
    private readonly Action<string, int?, string> _onExit;
    private readonly ILogger _logger;
    private readonly CancellationTokenSource _stopping = new();

    private long _sequence;
    private long _bytesOut;
    private int _finished;
    private bool _disposed;

    private TerminalSession(
        string terminalId,
        string shell,
        PseudoConsole console,
        Action<TerminalChunk> onOutput,
        Action<string, int?, string> onExit,
        ILogger logger)
    {
        TerminalId = terminalId;
        Shell = shell;
        _console = console;
        _onOutput = onOutput;
        _onExit = onExit;
        _logger = logger;
    }

    public string TerminalId { get; }
    public string Shell { get; }
    public int ProcessId => _console.ProcessId;

    /// <summary>Bytes of output carried since this shell started. A count, never content.</summary>
    public long BytesOut => Interlocked.Read(ref _bytesOut);

    /// <summary>
    /// Start a shell and begin pumping its output.
    /// </summary>
    public static TerminalSession Start(
        string terminalId,
        string shell,
        string commandLine,
        string? workingDirectory,
        short columns,
        short rows,
        Action<TerminalChunk> onOutput,
        Action<string, int?, string> onExit,
        ILogger logger)
    {
        PseudoConsole console = PseudoConsole.Start(commandLine, workingDirectory, columns, rows);
        var session = new TerminalSession(terminalId, shell, console, onOutput, onExit, logger);

        // On its own thread rather than the thread pool: this reads a pipe until the shell
        // exits, which is minutes or hours, and a pool thread parked on a blocking read is a
        // pool thread nothing else can have.
        var pump = new Thread(session.Pump)
        {
            IsBackground = true,
            Name = $"wolf-terminal-{terminalId}",
        };
        pump.Start();

        // And a second one, watching the process rather than the pipe.
        //
        // These are not the same event and the difference is not academic: conhost outlives
        // its client and keeps the output pipe open, so a shell that exits on its own — the
        // operator typing `exit`, a script finishing — would never produce an end-of-file
        // and the pump would wait for one forever. Watching the process and *then* closing
        // the console gives both: conhost flushes what it still holds, the pump drains it,
        // and the exit is reported after the last line rather than instead of it.
        var watcher = new Thread(session.WatchForExit)
        {
            IsBackground = true,
            Name = $"wolf-terminal-watch-{terminalId}",
        };
        watcher.Start();

        return session;
    }

    /// <summary>
    /// Read the console until it ends.
    ///
    /// The exit is detected by the pipe closing rather than by watching the process, because
    /// those two moments are not the same: a shell that has exited may still have output in
    /// flight, and reporting the exit first would drop the last thing it said — which, for
    /// somebody debugging a failing script, is the only line that mattered.
    /// </summary>
    private void Pump()
    {
        var buffer = new byte[ReadBufferBytes];

        // UTF-8 with a decoder that survives a multi-byte character split across two reads.
        // Without one, every such split becomes a replacement character in the middle of
        // somebody's output.
        System.Text.Decoder decoder = System.Text.Encoding.UTF8.GetDecoder();
        var characters = new char[ReadBufferBytes];

        try
        {
            while (!_stopping.IsCancellationRequested)
            {
                int read = _console.Output.Read(buffer, 0, buffer.Length);
                if (read <= 0) break;

                Interlocked.Add(ref _bytesOut, read);

                int decoded = decoder.GetChars(buffer, 0, read, characters, 0);
                if (decoded == 0) continue;

                _onOutput(new TerminalChunk(
                    TerminalId,
                    Interlocked.Increment(ref _sequence) - 1,
                    new string(characters, 0, decoded)));
            }
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException)
        {
            // The console closed under us, which is what disposing it does. Not a fault.
        }
        catch (Exception ex)
        {
            // Counted and named, without the output that caused it.
            _logger.LogError(ex, "Terminal {Terminal}: the output pump stopped unexpectedly.", TerminalId);
            Finish(null, "failed");
            return;
        }

        Finish(_console.ExitCode, _stopping.IsCancellationRequested ? "closed" : "exited");
    }

    /// <summary>Wait for the shell to end, then let the output pipe finish.</summary>
    private void WatchForExit()
    {
        if (!_console.WaitForExit(_stopping.Token)) return;

        // Closes the console and nothing else. The process handle stays, so the exit code is
        // still readable, and the pump gets its end-of-file after conhost has flushed.
        _console.CloseConsole();
    }

    /// <summary>
    /// Send keystrokes to the shell. False when there is no longer a shell to send them to.
    /// </summary>
    public bool Write(string data)
    {
        if (_disposed || _finished != 0) return false;

        try
        {
            byte[] bytes = System.Text.Encoding.UTF8.GetBytes(data);
            _console.Input.Write(bytes, 0, bytes.Length);
            _console.Input.Flush();
            return true;
        }
        catch (Exception ex) when (ex is IOException or ObjectDisposedException)
        {
            // The shell exited between the client typing and this arriving. The exit is
            // already on its way to them; saying so twice would be noise.
            return false;
        }
    }

    /// <summary>Tell the shell it is a different size.</summary>
    public bool Resize(short columns, short rows) =>
        !_disposed && _finished == 0 && _console.Resize(columns, rows);

    /// <summary>
    /// End the shell.
    ///
    /// The reason is carried through to the client, because "you closed it", "it exited" and
    /// "the stream it was on went away" are three different things to read.
    /// </summary>
    public void Close(string reason)
    {
        Finish(_console.ExitCode, reason);
        Dispose();
    }

    /// <summary>Report the end exactly once, whichever path got here first.</summary>
    private void Finish(int? exitCode, string reason)
    {
        if (Interlocked.Exchange(ref _finished, 1) != 0) return;

        _logger.LogInformation(
            "Terminal {Terminal} ({Shell}, pid {Pid}) ended: {Reason}. {Bytes} byte(s) of output.",
            TerminalId,
            Shell,
            ProcessId,
            reason,
            BytesOut);

        _onExit(TerminalId, exitCode, reason);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        _stopping.Cancel();
        _console.Dispose();
        _stopping.Dispose();
    }
}
