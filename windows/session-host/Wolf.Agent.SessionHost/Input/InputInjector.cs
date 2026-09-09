using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Microsoft.Extensions.Logging;
using Wolf.Agent.Core.Ipc;
using Wolf.Agent.SessionHost.Displays;

namespace Wolf.Agent.SessionHost.Input;

/// <summary>What happened to an injection attempt, and why if it failed.</summary>
public readonly record struct InjectionResult(bool Injected, string? Reason, bool Limitation)
{
    public static readonly InjectionResult Ok = new(true, null, false);

    public static InjectionResult Refused(string reason) => new(false, reason, false);

    public static InjectionResult Blocked(string reason) => new(false, reason, true);
}

/// <summary>
/// Keyboard and mouse injection, through <c>SendInput</c>.
///
/// Everything reaching this class is already a typed, bounded event — coordinates are
/// normalised and range-checked, keys are virtual-key codes in 1..254 — so nothing here
/// parses anything. That is the whole point of the input protocol: there is no string to
/// misinterpret and no coordinate that can address a pixel outside the display being
/// streamed.
///
/// Two Windows behaviours are reported rather than hidden:
///
///  * **UIPI.** This process runs as the signed-in user, not elevated. Windows refuses
///    injected input to a window at a higher integrity level, so a UAC prompt or an
///    elevated Task Manager silently swallows everything. `SendInput` says so — it returns
///    zero with `ERROR_ACCESS_DENIED` — and WOLF passes that on instead of leaving an
///    operator clicking at a window that will never respond.
///  * **The Secure Attention Sequence.** Ctrl+Alt+Del is delivered by Winlogon and cannot
///    be synthesised from a user-session process by any combination of key events. It is
///    refused with that reason rather than sent as three keystrokes that do nothing.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed partial class InputInjector
{
    private readonly ILogger<InputInjector> _logger;

    /// <summary>The display this stream is showing, which normalised coordinates map onto.</summary>
    private IpcDisplay _display;

    public InputInjector(IpcDisplay display, ILogger<InputInjector> logger)
    {
        _display = display;
        _logger = logger;

        // The virtual desktop metrics this class maps coordinates against are DPI-virtualised
        // for a process that has not declared awareness: on a 2560x1440 display at 125%, an
        // unaware process is told the desktop is 2048x1152, and every click lands short by a
        // fifth. The session host sets this at startup; setting it here as well means the
        // injector is correct wherever it is constructed rather than depending on the order
        // things happen to be created in.
        DpiAwareness.EnsurePerMonitorAware();
    }

    /// <summary>Point at a different display, when the stream switches.</summary>
    public void Retarget(IpcDisplay display) => _display = display;

    // -------------------------------------------------------------------------
    // Pointer
    // -------------------------------------------------------------------------

    public InjectionResult MovePointer(double x, double y)
    {
        (int absoluteX, int absoluteY) = ToVirtualDesktop(x, y);

        return Send(new NativeInput
        {
            Type = InputMouse,
            Data = new InputUnion
            {
                Mouse = new MouseInput
                {
                    Dx = absoluteX,
                    Dy = absoluteY,
                    Flags = MouseEventMove | MouseEventAbsolute | MouseEventVirtualDesk,
                },
            },
        });
    }

    public InjectionResult PressPointer(string button, bool down, double x, double y)
    {
        uint flags = button switch
        {
            "left" => down ? MouseEventLeftDown : MouseEventLeftUp,
            "right" => down ? MouseEventRightDown : MouseEventRightUp,
            "middle" => down ? MouseEventMiddleDown : MouseEventMiddleUp,
            "x1" or "x2" => down ? MouseEventXDown : MouseEventXUp,
            _ => 0,
        };

        if (flags == 0) return InjectionResult.Refused($"Unknown pointer button '{button}'.");

        // The position travels with the click. Moving and clicking as two calls lets
        // anything that happens in between land the click somewhere else.
        (int absoluteX, int absoluteY) = ToVirtualDesktop(x, y);

        return Send(new NativeInput
        {
            Type = InputMouse,
            Data = new InputUnion
            {
                Mouse = new MouseInput
                {
                    Dx = absoluteX,
                    Dy = absoluteY,
                    MouseData = button switch { "x1" => XButton1, "x2" => XButton2, _ => 0 },
                    Flags = flags | MouseEventMove | MouseEventAbsolute | MouseEventVirtualDesk,
                },
            },
        });
    }

    public InjectionResult Scroll(double x, double y, double deltaX, double deltaY)
    {
        (int absoluteX, int absoluteY) = ToVirtualDesktop(x, y);
        var events = new List<NativeInput>(2);

        if (deltaY != 0)
        {
            events.Add(WheelEvent(absoluteX, absoluteY, MouseEventWheel, deltaY));
        }

        if (deltaX != 0)
        {
            events.Add(WheelEvent(absoluteX, absoluteY, MouseEventHWheel, deltaX));
        }

        return events.Count == 0 ? InjectionResult.Ok : Send(events.ToArray());
    }

    private static NativeInput WheelEvent(int x, int y, uint flag, double notches) => new()
    {
        Type = InputMouse,
        Data = new InputUnion
        {
            Mouse = new MouseInput
            {
                Dx = x,
                Dy = y,
                // One notch is WHEEL_DELTA. Rounding away from zero keeps a small scroll
                // from becoming no scroll at all on a high-resolution trackpad.
                MouseData = unchecked((uint)(int)Math.Round(notches * WheelDelta, MidpointRounding.AwayFromZero)),
                Flags = flag | MouseEventAbsolute | MouseEventVirtualDesk,
            },
        },
    };

    // -------------------------------------------------------------------------
    // Keyboard
    // -------------------------------------------------------------------------

    public InjectionResult PressKey(int virtualKey, bool down, int? scanCode, bool extended)
    {
        if (virtualKey is < 1 or > 254) return InjectionResult.Refused("Not a virtual-key code.");

        // A scan code is supplied when the client knows it, and derived when it does not.
        // Games and remote-desktop-hostile applications read scan codes directly and see
        // nothing at all from an event that carries only a virtual key.
        ushort scan = scanCode is not null and >= 0 and <= 0xFFFF
            ? (ushort)scanCode.Value
            : (ushort)MapVirtualKey((uint)virtualKey, MapVkToVsc);

        uint flags = 0;
        if (!down) flags |= KeyEventKeyUp;
        if (extended) flags |= KeyEventExtendedKey;

        return Send(new NativeInput
        {
            Type = InputKeyboard,
            Data = new InputUnion
            {
                Keyboard = new KeyboardInput
                {
                    VirtualKey = (ushort)virtualKey,
                    ScanCode = scan,
                    Flags = flags,
                },
            },
        });
    }

    /// <summary>
    /// Type literal text.
    ///
    /// Sent as Unicode rather than decomposed into keystrokes, because an IME, autocorrect,
    /// or a phone keyboard produces characters that have no meaningful key-down sequence.
    /// Surrogate pairs go through as two events, which is what Windows expects.
    /// </summary>
    public InjectionResult TypeText(string value)
    {
        if (value.Length == 0) return InjectionResult.Ok;

        var events = new List<NativeInput>(value.Length * 2);

        foreach (char character in value)
        {
            // A newline arrives as a character but has to be a Return key press: injecting
            // U+000A puts nothing in most text fields.
            if (character is '\n' or '\r')
            {
                events.Add(KeyStroke(VkReturn, down: true));
                events.Add(KeyStroke(VkReturn, down: false));
                continue;
            }

            events.Add(UnicodeStroke(character, down: true));
            events.Add(UnicodeStroke(character, down: false));
        }

        return Send(events.ToArray());
    }

    private static NativeInput KeyStroke(ushort virtualKey, bool down, bool extended = false) => new()
    {
        Type = InputKeyboard,
        Data = new InputUnion
        {
            Keyboard = new KeyboardInput
            {
                VirtualKey = virtualKey,
                ScanCode = (ushort)MapVirtualKey(virtualKey, MapVkToVsc),
                Flags = (down ? 0u : KeyEventKeyUp) | (extended ? KeyEventExtendedKey : 0u),
            },
        },
    };

    private static NativeInput UnicodeStroke(char character, bool down) => new()
    {
        Type = InputKeyboard,
        Data = new InputUnion
        {
            Keyboard = new KeyboardInput
            {
                VirtualKey = 0,
                ScanCode = character,
                Flags = KeyEventUnicode | (down ? 0u : KeyEventKeyUp),
            },
        },
    };

    // -------------------------------------------------------------------------
    // System combinations
    // -------------------------------------------------------------------------

    /// <summary>
    /// Combinations Windows reserves.
    ///
    /// Two of these cannot be synthesised at all from a user-session process, and saying so
    /// is more useful than sending keystrokes that are silently discarded.
    /// </summary>
    public InjectionResult SystemCombo(string combo)
    {
        switch (combo)
        {
            case "ctrl-alt-del":
                return InjectionResult.Blocked(
                    "Ctrl+Alt+Delete is a Secure Attention Sequence. Windows delivers it from " +
                    "Winlogon, and no process in the signed-in session can produce it. It needs " +
                    "the WOLF privileged helper, which is not in this build.");

            case "win-l":
                return InjectionResult.Blocked(
                    "Windows handles Win+L itself and does not accept it from injected input. " +
                    "Use the WOLF lock command instead, which asks Windows directly.");

            case "alt-tab":
                return SendSequence((VkMenu, false), (VkTab, false), (VkTab, true), (VkMenu, true));

            case "win-tab":
                return SendSequence((VkLWin, false), (VkTab, false), (VkTab, true), (VkLWin, true));

            case "print-screen":
                return SendSequence((VkSnapshot, false), (VkSnapshot, true));

            default:
                return InjectionResult.Refused($"Unknown system combination '{combo}'.");
        }
    }

    private InjectionResult SendSequence(params (ushort Key, bool Up)[] strokes)
    {
        var events = new NativeInput[strokes.Length];
        for (int i = 0; i < strokes.Length; i++)
        {
            events[i] = KeyStroke(strokes[i].Key, down: !strokes[i].Up);
        }

        return Send(events);
    }

    /// <summary>
    /// Release every modifier this process may have pressed.
    ///
    /// Called when control is lost or a stream ends. Without it, a client that disconnects
    /// mid-chord leaves the remote machine with a stuck Ctrl, and the next person at that
    /// keyboard finds every keystroke turning into a shortcut.
    /// </summary>
    public InjectionResult ReleaseAllModifiers()
    {
        // Left and right are released separately rather than through the generic VK_SHIFT,
        // VK_CONTROL, and VK_MENU codes. Windows resolves a generic modifier to its
        // left-hand variant, so releasing the generic one leaves a stuck *right* Ctrl
        // exactly as stuck as it was.
        (ushort Key, bool Extended)[] modifiers =
        {
            (VkLShift, false),
            (VkRShift, false),
            (VkLControl, false),
            (VkRControl, true),
            (VkLMenu, false),
            (VkRMenu, true),
            (VkLWin, true),
            (VkRWin, true),
        };

        var events = new NativeInput[modifiers.Length];

        for (int i = 0; i < modifiers.Length; i++)
        {
            events[i] = KeyStroke(modifiers[i].Key, down: false, modifiers[i].Extended);
        }

        return Send(events);
    }

    // -------------------------------------------------------------------------
    // Coordinates
    // -------------------------------------------------------------------------

    /// <summary>
    /// Map a normalised point on the streamed display into the absolute range SendInput
    /// wants, against this machine's real virtual desktop.
    /// </summary>
    public (int X, int Y) ToVirtualDesktop(double x, double y) =>
        ToVirtualDesktop(x, y, _display, CurrentVirtualDesktop());

    /// <summary>
    /// Map a normalised point on one display into the absolute range SendInput wants.
    ///
    /// Two conversions, both easy to get subtly wrong. The normalised point is relative to
    /// the *captured display*, which may sit anywhere in the virtual desktop, including at
    /// negative coordinates when a second monitor is to the left of or above the primary
    /// one. The absolute range is 0..65535 across the whole virtual desktop, not across one
    /// screen — so on a two-monitor machine, half of that range belongs to the other screen
    /// and a click that ignores the origin lands on the wrong monitor.
    ///
    /// Static and given its desktop rather than reading the metrics itself, because a
    /// machine has whatever monitors it has: the arithmetic that decides which screen a
    /// click reaches cannot be checked on a single-display machine unless the layout is
    /// something a test can state.
    /// </summary>
    public static (int X, int Y) ToVirtualDesktop(
        double x,
        double y,
        IpcDisplay display,
        VirtualDesktop desktop)
    {
        double clampedX = Math.Clamp(x, 0, 1);
        double clampedY = Math.Clamp(y, 0, 1);

        // The point within the streamed display, in desktop pixels.
        double pixelX = display.OriginX + clampedX * (display.WidthPixels - 1);
        double pixelY = display.OriginY + clampedY * (display.HeightPixels - 1);

        double normalisedX = (pixelX - desktop.Left) / Math.Max(1, desktop.Width - 1);
        double normalisedY = (pixelY - desktop.Top) / Math.Max(1, desktop.Height - 1);

        return (
            (int)Math.Round(Math.Clamp(normalisedX, 0, 1) * AbsoluteMax),
            (int)Math.Round(Math.Clamp(normalisedY, 0, 1) * AbsoluteMax));
    }

    /// <summary>The virtual desktop this machine currently has, in desktop pixels.</summary>
    public static VirtualDesktop CurrentVirtualDesktop() => new(
        GetSystemMetrics(SmXVirtualScreen),
        GetSystemMetrics(SmYVirtualScreen),
        Math.Max(1, GetSystemMetrics(SmCxVirtualScreen)),
        Math.Max(1, GetSystemMetrics(SmCyVirtualScreen)));

    // -------------------------------------------------------------------------
    // The call itself
    // -------------------------------------------------------------------------

    private InjectionResult Send(params NativeInput[] events)
    {
        uint inserted = SendInput((uint)events.Length, events, Marshal.SizeOf<NativeInput>());
        if (inserted == events.Length) return InjectionResult.Ok;

        int error = Marshal.GetLastWin32Error();

        if (error == ErrorAccessDenied)
        {
            // UIPI. The window with focus is running at a higher integrity level than this
            // process, which is the normal case for a UAC prompt. Nothing was delivered.
            _logger.LogInformation("Input was blocked by Windows: the focused window is elevated.");
            return InjectionResult.Blocked(
                "The window in focus on that PC is running as administrator, and Windows does " +
                "not accept remote input into it. The WOLF privileged helper is needed for this, " +
                "and is not in this build.");
        }

        _logger.LogWarning(
            "SendInput accepted {Inserted} of {Total} events (error {Error}).",
            inserted,
            events.Length,
            error);

        return InjectionResult.Refused($"Windows accepted {inserted} of {events.Length} input events.");
    }

    // -------------------------------------------------------------------------
    // Interop
    // -------------------------------------------------------------------------

    private const uint InputMouse = 0;
    private const uint InputKeyboard = 1;

    private const uint MouseEventMove = 0x0001;
    private const uint MouseEventLeftDown = 0x0002;
    private const uint MouseEventLeftUp = 0x0004;
    private const uint MouseEventRightDown = 0x0008;
    private const uint MouseEventRightUp = 0x0010;
    private const uint MouseEventMiddleDown = 0x0020;
    private const uint MouseEventMiddleUp = 0x0040;
    private const uint MouseEventXDown = 0x0080;
    private const uint MouseEventXUp = 0x0100;
    private const uint MouseEventWheel = 0x0800;
    private const uint MouseEventHWheel = 0x1000;
    private const uint MouseEventAbsolute = 0x8000;
    private const uint MouseEventVirtualDesk = 0x4000;

    private const uint XButton1 = 0x0001;
    private const uint XButton2 = 0x0002;
    private const int WheelDelta = 120;

    private const uint KeyEventExtendedKey = 0x0001;
    private const uint KeyEventKeyUp = 0x0002;
    private const uint KeyEventUnicode = 0x0004;

    private const uint MapVkToVsc = 0;

    private const ushort VkMenu = 0x12;
    private const ushort VkReturn = 0x0D;
    private const ushort VkTab = 0x09;
    private const ushort VkSnapshot = 0x2C;
    private const ushort VkLWin = 0x5B;
    private const ushort VkRWin = 0x5C;
    private const ushort VkLShift = 0xA0;
    private const ushort VkRShift = 0xA1;
    private const ushort VkLControl = 0xA2;
    private const ushort VkRControl = 0xA3;
    private const ushort VkLMenu = 0xA4;
    private const ushort VkRMenu = 0xA5;

    private const int SmXVirtualScreen = 76;
    private const int SmYVirtualScreen = 77;
    private const int SmCxVirtualScreen = 78;
    private const int SmCyVirtualScreen = 79;

    /// <summary>The absolute coordinate range SendInput uses, per axis.</summary>
    public const int AbsoluteMax = 65535;

    private const int ErrorAccessDenied = 5;

    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput
    {
        public int Dx;
        public int Dy;
        public uint MouseData;
        public uint Flags;
        public uint Time;
        public IntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardInput
    {
        public ushort VirtualKey;
        public ushort ScanCode;
        public uint Flags;
        public uint Time;
        public IntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct HardwareInput
    {
        public uint Msg;
        public ushort ParamL;
        public ushort ParamH;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)]
        public MouseInput Mouse;

        [FieldOffset(0)]
        public KeyboardInput Keyboard;

        [FieldOffset(0)]
        public HardwareInput Hardware;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeInput
    {
        public uint Type;
        public InputUnion Data;
    }

    [LibraryImport("user32.dll", SetLastError = true)]
    private static partial uint SendInput(uint count, [In] NativeInput[] inputs, int size);

    // The entry point is named explicitly: unlike DllImport, LibraryImport does not probe
    // for the A/W suffix, and "MapVirtualKey" does not exist as an export. Without this the
    // first keystroke that arrives without a client-supplied scan code throws.
    [LibraryImport("user32.dll", EntryPoint = "MapVirtualKeyW")]
    private static partial uint MapVirtualKey(uint code, uint mapType);

    [LibraryImport("user32.dll")]
    private static partial int GetSystemMetrics(int index);
}
