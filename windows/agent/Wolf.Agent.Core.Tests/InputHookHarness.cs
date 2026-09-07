using System.Runtime.InteropServices;

namespace Wolf.Agent.Core.Tests;

/// <summary>
/// Observing injected input without letting it reach anything.
///
/// Testing injection by injecting is the only way to prove it works, and doing that naively
/// would type into whatever window happens to have focus on the machine running the tests.
/// A low-level hook is called by Windows *before* the event reaches any application, and
/// returning a non-zero value from it discards the event — so the input is really produced,
/// really carried through the input stack, and really observed, while no window ever sees
/// it. The pointer does not move and nothing gets typed.
///
/// Low-level hooks are called on the thread that installed them, and only while that thread
/// is checking its message queue, so the hook, the injection, and the pump all have to
/// happen on one thread. That is what <see cref="LowLevelHook.Run"/> arranges.
/// </summary>
internal readonly record struct ObservedKey(uint VirtualKey, uint ScanCode, bool IsUp, bool Injected);

internal readonly record struct ObservedMouse(int Message, int X, int Y, short WheelDelta, bool Injected);

internal abstract class LowLevelHook : IDisposable
{
    private readonly int _hookId;
    private HookProc? _callback;

    protected LowLevelHook(int hookId)
    {
        _hookId = hookId;
    }

    /// <summary>Install the hook, run <paramref name="inject"/>, and pump until it settles.</summary>
    public void Run(Action inject, int settleMs = 400)
    {
        Exception? failure = null;

        var thread = new Thread(() =>
        {
            IntPtr hook = IntPtr.Zero;
            try
            {
                // Held in a field so the delegate is not collected while Windows holds a
                // pointer to it — a crash that only shows up under GC pressure.
                _callback = Callback;
                hook = SetWindowsHookEx(_hookId, _callback, IntPtr.Zero, 0);
                if (hook == IntPtr.Zero)
                {
                    failure = new InvalidOperationException(
                        $"The hook could not be installed (error {Marshal.GetLastWin32Error()}).");
                    return;
                }

                inject();

                // PeekMessage is what causes the queued low-level hook callbacks to run.
                DateTime deadline = DateTime.UtcNow.AddMilliseconds(settleMs);
                while (DateTime.UtcNow < deadline)
                {
                    while (PeekMessage(out Msg message, IntPtr.Zero, 0, 0, PmRemove))
                    {
                        TranslateMessage(ref message);
                        DispatchMessage(ref message);
                    }

                    Thread.Sleep(5);
                }
            }
            catch (Exception ex)
            {
                failure = ex;
            }
            finally
            {
                if (hook != IntPtr.Zero) UnhookWindowsHookEx(hook);
            }
        });

        thread.SetApartmentState(ApartmentState.STA);
        thread.IsBackground = true;
        thread.Start();
        thread.Join(TimeSpan.FromSeconds(15));

        if (failure is not null) throw failure;
    }

    private IntPtr Callback(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code < 0) return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);

        Record(wParam.ToInt32(), lParam);

        // Swallow it. Nothing on this machine ever sees the event.
        return 1;
    }

    protected abstract void Record(int message, IntPtr lParam);

    public void Dispose() => _callback = null;

    // -------------------------------------------------------------------------
    // Interop
    // -------------------------------------------------------------------------

    protected const int WhKeyboardLl = 13;
    protected const int WhMouseLl = 14;
    private const int WmKeyUp = 0x0101;
    private const int WmSysKeyUp = 0x0105;
    private const uint LlkhfInjected = 0x00000010;
    private const uint LlmhfInjected = 0x00000001;
    private const uint PmRemove = 0x0001;

    protected static bool IsKeyUp(int message) => message is WmKeyUp or WmSysKeyUp;

    protected static bool WasInjected(uint flags, bool keyboard) =>
        (flags & (keyboard ? LlkhfInjected : LlmhfInjected)) != 0;

    private delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    protected struct KbdLlHookStruct
    {
        public uint VirtualKey;
        public uint ScanCode;
        public uint Flags;
        public uint Time;
        public IntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    protected struct MsllHookStruct
    {
        public int X;
        public int Y;
        public uint MouseData;
        public uint Flags;
        public uint Time;
        public IntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Msg
    {
        public IntPtr Hwnd;
        public uint Message;
        public IntPtr WParam;
        public IntPtr LParam;
        public uint Time;
        public int PtX;
        public int PtY;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint threadId);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int code, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PeekMessage(out Msg message, IntPtr hWnd, uint filterMin, uint filterMax, uint remove);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TranslateMessage(ref Msg message);

    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref Msg message);
}

internal sealed class KeyboardHook : LowLevelHook
{
    public KeyboardHook()
        : base(WhKeyboardLl)
    {
    }

    public List<ObservedKey> Events { get; } = new();

    protected override void Record(int message, IntPtr lParam)
    {
        KbdLlHookStruct data = Marshal.PtrToStructure<KbdLlHookStruct>(lParam);
        Events.Add(new ObservedKey(
            data.VirtualKey,
            data.ScanCode,
            IsKeyUp(message),
            WasInjected(data.Flags, keyboard: true)));
    }
}

internal sealed class MouseHook : LowLevelHook
{
    public MouseHook()
        : base(WhMouseLl)
    {
    }

    public List<ObservedMouse> Events { get; } = new();

    protected override void Record(int message, IntPtr lParam)
    {
        MsllHookStruct data = Marshal.PtrToStructure<MsllHookStruct>(lParam);
        Events.Add(new ObservedMouse(
            message,
            data.X,
            data.Y,
            (short)(data.MouseData >> 16),
            WasInjected(data.Flags, keyboard: false)));
    }
}
