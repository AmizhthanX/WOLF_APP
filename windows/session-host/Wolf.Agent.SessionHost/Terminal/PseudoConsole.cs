using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Microsoft.Win32.SafeHandles;

namespace Wolf.Agent.SessionHost.Terminal;

/// <summary>
/// A Windows pseudo console, and the process running inside it.
///
/// This is the mechanism `wt.exe` and VS Code's terminal use, and it is the only supported
/// way to host a shell whose output is meant for something other than a console window.
/// The alternative — redirecting stdout of `cmd.exe` through a pipe — produces a shell that
/// knows it is not on a terminal: no prompt colouring, no line editing, no cursor movement,
/// and programs that check `isatty` behaving differently from how they would on the machine
/// itself. An operator troubleshooting a PC needs the shell that PC actually has.
///
/// Three things happen here and they have to happen in this order:
///
///  1. Two anonymous pipes: one this class writes into, one it reads from.
///  2. `CreatePseudoConsole` binds them to a console of a given size. From this point
///     Windows owns the terminal emulation — line wrapping, escape sequences, the lot.
///  3. `CreateProcess` with an attribute list naming that pseudo console, which is what
///     makes the child attach to it instead of inheriting whatever this process has.
///
/// Everything is closed in the reverse order on the way out, because closing the pseudo
/// console while the child still holds it is how you get a hang rather than an error.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed partial class PseudoConsole : IDisposable
{
    private IntPtr _handle;
    private SafeFileHandle? _inputWrite;
    private SafeFileHandle? _outputRead;
    private SafeProcessHandle? _process;
    private IntPtr _attributeList;
    private bool _disposed;

    /// <summary>
    /// Guards the process handle against the read loop.
    ///
    /// The pump thread asks for the exit code the moment its pipe closes, and closing the
    /// pipe is the *first* thing disposal does — so without this the two race, and the loser
    /// dereferences a disposed handle. Caught by the tests on the first run, which is what
    /// they are for.
    /// </summary>
    private readonly object _gate = new();

    /// <summary>The last code read while there was still a handle to read it from.</summary>
    private int? _exitCode;

    private PseudoConsole()
    {
    }

    /// <summary>The pseudo console's own process id, for the operator and the audit trail.</summary>
    public int ProcessId { get; private set; }

    /// <summary>Where the shell's output arrives. Owned by this instance.</summary>
    public Stream Output { get; private set; } = Stream.Null;

    /// <summary>Where keystrokes go. Owned by this instance.</summary>
    public Stream Input { get; private set; } = Stream.Null;

    /// <summary>
    /// Start a shell in a pseudo console of the given size.
    /// </summary>
    /// <param name="commandLine">
    /// The full command line, built by the caller from a *fixed* executable path. Nothing
    /// here parses it: this class is the mechanism, and deciding what may run is a decision
    /// that belongs where the session and its capabilities are.
    /// </param>
    /// <exception cref="Win32Exception">
    /// Thrown with the real Windows error, so a shell that is not installed is reported as
    /// "not found" rather than as a generic failure.
    /// </exception>
    public static PseudoConsole Start(
        string commandLine,
        string? workingDirectory,
        short columns,
        short rows)
    {
        var console = new PseudoConsole();

        try
        {
            console.Create(commandLine, workingDirectory, columns, rows);
            return console;
        }
        catch
        {
            console.Dispose();
            throw;
        }
    }

    private void Create(string commandLine, string? workingDirectory, short columns, short rows)
    {
        // The two pipes are crossed on purpose: what this process writes is what the console
        // reads, and vice versa. Getting this backwards produces a shell that appears to
        // start and then never says anything.
        if (!CreatePipe(out SafeFileHandle inputRead, out SafeFileHandle inputWrite, IntPtr.Zero, 0))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "The terminal's input pipe could not be created.");
        }

        if (!CreatePipe(out SafeFileHandle outputRead, out SafeFileHandle outputWrite, IntPtr.Zero, 0))
        {
            inputRead.Dispose();
            inputWrite.Dispose();
            throw new Win32Exception(Marshal.GetLastWin32Error(), "The terminal's output pipe could not be created.");
        }

        _inputWrite = inputWrite;
        _outputRead = outputRead;

        try
        {
            var size = new Coord { X = columns, Y = rows };

            int created = CreatePseudoConsole(size, inputRead, outputWrite, 0, out _handle);
            if (created != 0) throw new Win32Exception(created, "The pseudo console could not be created.");

            StartProcess(commandLine, workingDirectory);
        }
        finally
        {
            // The console owns its ends now. Holding on to them would keep the pipes open
            // after the shell exits, and the read loop would wait forever for an EOF that
            // never comes.
            inputRead.Dispose();
            outputWrite.Dispose();
        }

        Input = new FileStream(_inputWrite, FileAccess.Write);
        Output = new FileStream(_outputRead, FileAccess.Read);
    }

    private unsafe void StartProcess(string commandLine, string? workingDirectory)
    {
        var startup = new StartupInfoEx();
        startup.StartupInfo.cb = Marshal.SizeOf<StartupInfoEx>();

        // The shell must be given *no* standard handles, and this is the detail that decides
        // whether any of this works.
        //
        // A console child with no standard handles of its own falls back to `CONOUT$` and
        // `CONIN$` — its console, which is the pseudo console. Left unset, it inherits this
        // process's standard handles instead, and those are whatever the agent was started
        // with: pipes to a service host, or nothing at all. The shell then attaches to the
        // pseudo console correctly, reports the right size from `mode con`, and writes every
        // byte of its output somewhere the operator will never see.
        //
        // That is exactly what happened the first time this ran, and it is invisible from a
        // terminal: run the same code with a console attached and the output goes to the
        // console, so it looks like it works.
        startup.StartupInfo.Flags = StartfUsestdhandles;
        startup.StartupInfo.StdInput = IntPtr.Zero;
        startup.StartupInfo.StdOutput = IntPtr.Zero;
        startup.StartupInfo.StdError = IntPtr.Zero;

        // Asked for the size first, as the API requires: it fails with
        // ERROR_INSUFFICIENT_BUFFER and writes how much it wanted.
        IntPtr listSize = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref listSize);

        _attributeList = Marshal.AllocHGlobal(listSize);
        startup.AttributeList = _attributeList;

        if (!InitializeProcThreadAttributeList(_attributeList, 1, 0, ref listSize))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "The process attribute list could not be created.");
        }

        if (!UpdateProcThreadAttribute(
                _attributeList,
                0,
                ProcThreadAttributePseudoconsole,
                _handle,
                (IntPtr)IntPtr.Size,
                IntPtr.Zero,
                IntPtr.Zero))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "The shell could not be attached to the terminal.");
        }

        // A mutable buffer, because CreateProcessW writes into its command line argument.
        // Passing a managed string directly is the classic way to corrupt the string
        // interning table.
        char[] mutableCommandLine = new char[commandLine.Length + 1];
        commandLine.CopyTo(0, mutableCommandLine, 0, commandLine.Length);

        bool started;
        ProcessInformation information;

        fixed (char* line = mutableCommandLine)
        {
            started = CreateProcessW(
                null,
                line,
                IntPtr.Zero,
                IntPtr.Zero,
                // Deliberately false. The child gets the pseudo console through the
                // attribute list; inheriting every other handle this process holds would
                // hand a shell the pipes and sockets of the stream it was opened from.
                false,
                ExtendedStartupinfoPresent | CreateUnicodeEnvironment,
                IntPtr.Zero,
                string.IsNullOrWhiteSpace(workingDirectory) ? null : workingDirectory,
                ref startup,
                out information);
        }

        if (!started)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "The shell could not be started.");
        }

        CloseHandle(information.Thread);
        _process = new SafeProcessHandle(information.Process, ownsHandle: true);
        ProcessId = information.ProcessId;
    }

    /// <summary>
    /// Tell the console it is a different size. False when there was no console to tell.
    ///
    /// A shell that has already exited cannot be resized, and the caller is about to be told
    /// it exited — so the answer is returned rather than thrown, and the reason the client
    /// sees is the exit rather than a resize that failed because of it.
    /// </summary>
    public bool Resize(short columns, short rows)
    {
        if (_disposed || _handle == IntPtr.Zero) return false;

        return ResizePseudoConsole(_handle, new Coord { X = columns, Y = rows }) == 0;
    }

    /// <summary>Whether the shell is still running.</summary>
    public bool IsRunning
    {
        get { lock (_gate) return RunningLocked(); }
    }

    /// <summary>
    /// The shell's exit code, or null while it is still running.
    ///
    /// Answerable after disposal, because that is exactly when the read loop asks: the code
    /// is remembered on the way out rather than read from a handle that has gone.
    /// </summary>
    public int? ExitCode
    {
        get { lock (_gate) return ReadExitCodeLocked(); }
    }

    private bool RunningLocked() =>
        !_disposed &&
        _process is { IsInvalid: false } &&
        GetExitCodeProcess(_process, out uint code) &&
        code == StillActive;

    private int? ReadExitCodeLocked()
    {
        if (_disposed || _process is null || _process.IsInvalid) return _exitCode;
        if (!GetExitCodeProcess(_process, out uint code)) return _exitCode;
        if (code == StillActive) return null;

        _exitCode = unchecked((int)code);
        return _exitCode;
    }

    /// <summary>
    /// Close the console, leaving the process handle alone.
    ///
    /// This is how the shell's exit becomes an end-of-file on the output pipe. Nothing else
    /// does it: conhost outlives its client and keeps the pipe open, so a reader waiting for
    /// EOF on a shell that has already gone waits forever. Closing the console makes conhost
    /// flush whatever it still holds and then let go, which is the order that matters —
    /// somebody debugging a failing script needs the last line it printed.
    /// </summary>
    public void CloseConsole()
    {
        lock (_gate)
        {
            ReadExitCodeLocked();

            if (_handle == IntPtr.Zero) return;

            ClosePseudoConsole(_handle);
            _handle = IntPtr.Zero;
        }
    }

    /// <summary>
    /// Whether the shell has ended, checked without holding anything open.
    ///
    /// Polled rather than waited on. A wait needs the handle held for the duration, which is
    /// the one thing disposal must be able to do at any moment; a tenth of a second of
    /// latency on a shell exiting is not something anybody notices.
    /// </summary>
    public bool WaitForExit(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            if (!IsRunning) return true;

            try
            {
                Task.Delay(100, cancellationToken).GetAwaiter().GetResult();
            }
            catch (OperationCanceledException)
            {
                return false;
            }
        }

        return false;
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed) return;

            // Read before anything is torn down. After this the handle is gone and the code
            // is whatever was remembered here, which is the only answer the read loop can
            // still be given.
            ReadExitCodeLocked();

            // Order matters. Closing the pseudo console signals the shell to exit and
            // releases the pipe ends it holds; doing it after freeing the attribute list, or
            // while still holding the write end, is how this hangs instead of closing.
            if (_handle != IntPtr.Zero)
            {
                ClosePseudoConsole(_handle);
                _handle = IntPtr.Zero;
            }

            if (_process is { IsInvalid: false })
            {
                // The console asked politely a moment ago. This is for the shell that did
                // not take the hint — a `ping -t` left running is a process nobody will ever
                // close.
                if (RunningLocked()) TerminateProcess(_process, 1);
                _process.Dispose();
            }

            // Set last, so everything above still had a handle to work with and everything
            // arriving afterwards is answered from what was remembered.
            _disposed = true;

            if (_attributeList != IntPtr.Zero)
            {
                DeleteProcThreadAttributeList(_attributeList);
                Marshal.FreeHGlobal(_attributeList);
                _attributeList = IntPtr.Zero;
            }
        }

        // Outside the lock: closing a stream can block on a reader, and the reader is the
        // thread that wants this lock to ask for the exit code.
        Input.Dispose();
        Output.Dispose();
    }

    /* --------------------------------------------------------------------- */
    /* Interop                                                                */
    /* --------------------------------------------------------------------- */

    private const uint StillActive = 259;
    private const int ExtendedStartupinfoPresent = 0x00080000;
    private const int StartfUsestdhandles = 0x00000100;
    private const int CreateUnicodeEnvironment = 0x00000400;
    private static readonly IntPtr ProcThreadAttributePseudoconsole = (IntPtr)0x00020016;

    [StructLayout(LayoutKind.Sequential)]
    private struct Coord
    {
        public short X;
        public short Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo
    {
        public int cb;
        public IntPtr Reserved;
        public IntPtr Desktop;
        public IntPtr Title;
        public int X;
        public int Y;
        public int XSize;
        public int YSize;
        public int XCountChars;
        public int YCountChars;
        public int FillAttribute;
        public int Flags;
        public short ShowWindow;
        public short Reserved2Length;
        public IntPtr Reserved2;
        public IntPtr StdInput;
        public IntPtr StdOutput;
        public IntPtr StdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfoEx
    {
        public StartupInfo StartupInfo;
        public IntPtr AttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr Process;
        public IntPtr Thread;
        public int ProcessId;
        public int ThreadId;
    }

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool CreatePipe(
        out SafeFileHandle readPipe,
        out SafeFileHandle writePipe,
        IntPtr attributes,
        int size);

    [LibraryImport("kernel32.dll")]
    private static partial int CreatePseudoConsole(
        Coord size,
        SafeFileHandle input,
        SafeFileHandle output,
        uint flags,
        out IntPtr handle);

    [LibraryImport("kernel32.dll")]
    private static partial int ResizePseudoConsole(IntPtr handle, Coord size);

    [LibraryImport("kernel32.dll")]
    private static partial void ClosePseudoConsole(IntPtr handle);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool InitializeProcThreadAttributeList(
        IntPtr attributeList,
        int attributeCount,
        int flags,
        ref IntPtr size);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool UpdateProcThreadAttribute(
        IntPtr attributeList,
        uint flags,
        IntPtr attribute,
        IntPtr value,
        IntPtr size,
        IntPtr previousValue,
        IntPtr returnSize);

    [LibraryImport("kernel32.dll")]
    private static partial void DeleteProcThreadAttributeList(IntPtr attributeList);

    [LibraryImport("kernel32.dll", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static unsafe partial bool CreateProcessW(
        string? applicationName,
        char* commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
        int creationFlags,
        IntPtr environment,
        string? currentDirectory,
        ref StartupInfoEx startupInfo,
        out ProcessInformation processInformation);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool GetExitCodeProcess(SafeProcessHandle process, out uint exitCode);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool TerminateProcess(SafeProcessHandle process, uint exitCode);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool CloseHandle(IntPtr handle);
}
