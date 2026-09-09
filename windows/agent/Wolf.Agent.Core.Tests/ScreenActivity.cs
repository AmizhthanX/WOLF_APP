using System.Runtime.InteropServices;

namespace Wolf.Agent.Core.Tests;

/// <summary>
/// Something changing on screen, so capture performance can be measured at all.
///
/// Windows Graphics Capture delivers a frame when the composition changes, so an idle
/// desktop produces almost nothing — which is correct behaviour and useless for measuring a
/// pipeline under load. Rather than hoping somebody is moving a window at the time, these
/// runs drive the screen themselves.
///
/// It is a small labelled window in the bottom-right corner that repaints while the tests
/// that need it are running, and then goes away. That is intrusive, and deliberately the
/// least intrusive thing that works: painting straight onto the desktop would leave
/// artifacts on somebody's screen, and injecting mouse movement would move a pointer they
/// are using. A window that says what it is beats a mystery.
///
/// The ordinary suite needs this as much as the performance one does, and for longer than it
/// looks. Without it the capture tests pass or fail on whether anything happened to be
/// moving on the developer's screen: runs of the same unchanged tree have failed six, three,
/// one and zero of twelve. A suite that reports a different answer each time is not
/// measuring the product.
/// </summary>
public sealed class ScreenActivity : IDisposable
{
    private const int Width = 260;
    private const int Height = 90;

    private readonly Thread _thread;
    private readonly CancellationTokenSource _stopping = new();
    private readonly ManualResetEventSlim _ready = new(false);

    // Held so the window class's procedure is not collected while Windows holds a pointer.
    private WndProc? _procedure;

    public ScreenActivity()
    {
        _thread = new Thread(Run)
        {
            Name = "WOLF performance screen activity",
            IsBackground = true,
        };

        _thread.SetApartmentState(ApartmentState.STA);
        _thread.Start();

        // Wait for the window before the caller starts timing, so the first frames are not
        // measured against a screen that is still idle.
        _ready.Wait(TimeSpan.FromSeconds(3));
    }

    private void Run()
    {
        IntPtr instance = GetModuleHandle(null);
        _procedure = DefWindowProc;

        string className = "WolfPerfActivity" + Environment.CurrentManagedThreadId;

        var windowClass = new WndClassEx
        {
            cbSize = Marshal.SizeOf<WndClassEx>(),
            lpfnWndProc = Marshal.GetFunctionPointerForDelegate(_procedure),
            hInstance = instance,
            lpszClassName = className,
            hbrBackground = IntPtr.Zero,
        };

        if (RegisterClassEx(ref windowClass) == 0)
        {
            _ready.Set();
            return;
        }

        int left = GetSystemMetrics(SmCxScreen) - Width - 40;
        int top = GetSystemMetrics(SmCyScreen) - Height - 60;

        IntPtr window = CreateWindowEx(
            WsExToolWindow | WsExTopMost | WsExNoActivate,
            className,
            "WOLF performance test",
            WsPopup | WsVisible | WsBorder,
            left,
            top,
            Width,
            Height,
            IntPtr.Zero,
            IntPtr.Zero,
            instance,
            IntPtr.Zero);

        if (window == IntPtr.Zero)
        {
            _ready.Set();
            return;
        }

        ShowWindow(window, SwShowNoActivate);
        _ready.Set();

        var frame = 0;

        try
        {
            while (!_stopping.IsCancellationRequested)
            {
                // Painted straight to the window's own device context. A WM_PAINT handler
                // would be more conventional and buys nothing here: what matters is that the
                // pixels change, roughly at a display refresh.
                IntPtr dc = GetDC(window);
                if (dc != IntPtr.Zero)
                {
                    var area = new Rect { Left = 0, Top = 0, Right = Width, Bottom = Height };
                    IntPtr brush = CreateSolidBrush(Colour(frame));

                    _ = FillRect(dc, ref area, brush);
                    DeleteObject(brush);
                    _ = ReleaseDC(window, dc);
                }

                frame++;

                while (PeekMessage(out Msg message, IntPtr.Zero, 0, 0, PmRemove))
                {
                    TranslateMessage(ref message);
                    DispatchMessage(ref message);
                }

                Thread.Sleep(8);
            }
        }
        finally
        {
            DestroyWindow(window);
            UnregisterClass(className, instance);
        }
    }

    /// <summary>
    /// A colour that changes every frame, and changes a lot.
    ///
    /// A gently shifting gradient would compress to almost nothing and measure an encoder
    /// that has been handed an easy job. Cycling hard between distant colours keeps every
    /// frame genuinely different from the last.
    /// </summary>
    private static uint Colour(int frame)
    {
        byte red = (byte)((frame * 37) % 256);
        byte green = (byte)((frame * 91) % 256);
        byte blue = (byte)((frame * 53) % 256);
        return (uint)(red | (green << 8) | (blue << 16));
    }

    public void Dispose()
    {
        _stopping.Cancel();
        _thread.Join(TimeSpan.FromSeconds(2));
        _stopping.Dispose();
        _ready.Dispose();
    }

    private const int SmCxScreen = 0;
    private const int SmCyScreen = 1;
    private const uint WsPopup = 0x80000000;
    private const uint WsVisible = 0x10000000;
    private const uint WsBorder = 0x00800000;
    private const uint WsExToolWindow = 0x00000080;
    private const uint WsExTopMost = 0x00000008;
    private const uint WsExNoActivate = 0x08000000;
    private const int SwShowNoActivate = 4;
    private const uint PmRemove = 0x0001;

    private delegate IntPtr WndProc(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WndClassEx
    {
        public int cbSize;
        public uint style;
        public IntPtr lpfnWndProc;
        public int cbClsExtra;
        public int cbWndExtra;
        public IntPtr hInstance;
        public IntPtr hIcon;
        public IntPtr hCursor;
        public IntPtr hbrBackground;
        public string? lpszMenuName;
        public string lpszClassName;
        public IntPtr hIconSm;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
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

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandle(string? name);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern ushort RegisterClassEx(ref WndClassEx windowClass);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnregisterClass(string className, IntPtr instance);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateWindowEx(
        uint exStyle,
        string className,
        string windowName,
        uint style,
        int x,
        int y,
        int width,
        int height,
        IntPtr parent,
        IntPtr menu,
        IntPtr instance,
        IntPtr param);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DestroyWindow(IntPtr window);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ShowWindow(IntPtr window, int command);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr DefWindowProc(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern IntPtr GetDC(IntPtr window);

    [DllImport("user32.dll")]
    private static extern int ReleaseDC(IntPtr window, IntPtr dc);

    [DllImport("user32.dll")]
    private static extern int FillRect(IntPtr dc, ref Rect area, IntPtr brush);

    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateSolidBrush(uint colour);

    [DllImport("gdi32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DeleteObject(IntPtr handle);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PeekMessage(out Msg message, IntPtr window, uint filterMin, uint filterMax, uint remove);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TranslateMessage(ref Msg message);

    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref Msg message);
}
