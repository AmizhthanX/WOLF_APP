using System.Runtime.InteropServices;
using Microsoft.Extensions.Logging.Abstractions;
using Wolf.Agent.Core.Ipc;
using Wolf.Agent.SessionHost.Input;
using Xunit;
using Xunit.Abstractions;

namespace Wolf.Agent.Core.Tests;

/// <summary>
/// Input injection, exercised through the real <c>SendInput</c> — without touching anything.
///
/// Testing injection by injecting is the only way to prove it works, and doing that naively
/// would type into whatever window happens to have focus on the machine running the tests.
/// So each test installs a low-level hook, injects, and *swallows* the event in the hook:
/// Windows calls the hook before the event reaches any application, and returning non-zero
/// discards it. The event is really produced, really carried through the input stack, and
/// really observed — and no window ever sees it, so the pointer does not move and nothing
/// gets typed.
///
/// The keys used are F13–F24, which exist in the virtual-key table and on essentially no
/// keyboard, so even a failure of the swallow would land on something inert.
/// </summary>
[Collection("Capture")]
public sealed class InputInjectionTests
{
    private readonly ITestOutputHelper _output;

    public InputInjectionTests(ITestOutputHelper output)
    {
        _output = output;
    }

    private const int WmMouseWheel = 0x020A;
    private const uint VkPacket = 0xE7;

    private const int SmXVirtualScreen = 76;
    private const int SmYVirtualScreen = 77;
    private const int SmCxVirtualScreen = 78;
    private const int SmCyVirtualScreen = 79;

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);

    private static IpcDisplay Display(
        int width = 1920,
        int height = 1080,
        int originX = 0,
        int originY = 0) =>
        new("\\\\.\\DISPLAY1", "Test", width, height, 60, true, 1, false, originX, originY);

    private static InputInjector Injector(IpcDisplay? display = null) =>
        new(display ?? Display(), NullLogger<InputInjector>.Instance);

    /* --------------------------------------------------------------------- */
    /* Coordinate mapping                                                     */
    /* --------------------------------------------------------------------- */

    [Fact]
    public void The_corners_of_the_streamed_display_map_to_the_corners_of_the_screen()
    {
        // A single-display machine is the case where the mapping should be an identity, and
        // getting it wrong here would put every click a few pixels off in a way that looks
        // like input lag rather than a coordinate bug.
        int width = GetSystemMetrics(SmCxVirtualScreen);
        int height = GetSystemMetrics(SmCyVirtualScreen);
        if (width <= 0 || height <= 0) return;

        InputInjector injector = Injector(Display(width, height, GetSystemMetrics(SmXVirtualScreen), GetSystemMetrics(SmYVirtualScreen)));

        Assert.Equal((0, 0), injector.ToVirtualDesktop(0, 0));
        Assert.Equal((InputInjector.AbsoluteMax, InputInjector.AbsoluteMax), injector.ToVirtualDesktop(1, 1));

        (int centreX, int centreY) = injector.ToVirtualDesktop(0.5, 0.5);
        Assert.InRange(centreX, InputInjector.AbsoluteMax / 2 - 40, InputInjector.AbsoluteMax / 2 + 40);
        Assert.InRange(centreY, InputInjector.AbsoluteMax / 2 - 40, InputInjector.AbsoluteMax / 2 + 40);
    }

    [Fact]
    public void A_coordinate_outside_the_unit_square_is_clamped_rather_than_wrapped()
    {
        InputInjector injector = Injector();

        // Bounded already by the protocol, so this is the second line of defence. Wrapping
        // instead of clamping would turn a malformed coordinate into a click on the far
        // side of the desktop.
        Assert.Equal(injector.ToVirtualDesktop(0, 0), injector.ToVirtualDesktop(-5, -5));
        Assert.Equal(injector.ToVirtualDesktop(1, 1), injector.ToVirtualDesktop(9, 9));
    }

    /* --------------------------------------------------------------------- */
    /* Combinations Windows reserves                                          */
    /* --------------------------------------------------------------------- */

    [Theory]
    [InlineData("ctrl-alt-del")]
    [InlineData("win-l")]
    public void A_combination_Windows_reserves_is_refused_with_the_reason(string combo)
    {
        InjectionResult result = Injector().SystemCombo(combo);

        _output.WriteLine($"{combo}: {result.Reason}");

        // Sending three keystrokes that Windows discards would look like a WOLF bug to the
        // operator. Saying which boundary is in the way is the whole point.
        Assert.False(result.Injected);
        Assert.True(result.Limitation);
        Assert.NotNull(result.Reason);
    }

    [Fact]
    public void An_unknown_key_code_is_refused_before_it_reaches_Windows()
    {
        Assert.False(Injector().PressKey(0, down: true, scanCode: null, extended: false).Injected);
        Assert.False(Injector().PressKey(255, down: true, scanCode: null, extended: false).Injected);
        Assert.False(Injector().PressPointer("thumb", down: true, 0.5, 0.5).Injected);
    }

    /* --------------------------------------------------------------------- */
    /* Real injection, observed and swallowed                                 */
    /* --------------------------------------------------------------------- */

    [Fact]
    public void A_key_press_reaches_the_Windows_input_stack_and_is_marked_injected()
    {
        const int f24 = 0x87;

        using var hook = new KeyboardHook();
        InjectionResult down = default;
        InjectionResult up = default;

        hook.Run(() =>
        {
            InputInjector injector = Injector();
            down = injector.PressKey(f24, down: true, scanCode: null, extended: false);
            up = injector.PressKey(f24, down: false, scanCode: null, extended: false);
        });

        _output.WriteLine($"observed {hook.Events.Count} key events: " +
            string.Join(", ", hook.Events.Select(e => $"vk={e.VirtualKey} up={e.IsUp} injected={e.Injected} scan={e.ScanCode}")));

        Assert.True(down.Injected, down.Reason);
        Assert.True(up.Injected, up.Reason);

        Assert.Contains(hook.Events, e => e.VirtualKey == f24 && !e.IsUp);
        Assert.Contains(hook.Events, e => e.VirtualKey == f24 && e.IsUp);

        // Every event carries the injected flag, which is how anti-cheat and accessibility
        // software distinguishes remote control from a person at the keyboard. WOLF does
        // not hide it, and could not honestly.
        Assert.All(hook.Events.Where(e => e.VirtualKey == f24), e => Assert.True(e.Injected));

        // A scan code is derived when the client does not supply one, so applications that
        // read scan codes directly see a real key rather than a zero.
        Assert.All(hook.Events.Where(e => e.VirtualKey == f24), e => Assert.NotEqual(0u, e.ScanCode));
    }

    [Fact]
    public void A_supplied_scan_code_is_passed_through_rather_than_recomputed()
    {
        const int f23 = 0x86;
        const int scanCode = 0x6E;

        using var hook = new KeyboardHook();
        hook.Run(() =>
        {
            InputInjector injector = Injector();
            injector.PressKey(f23, down: true, scanCode, extended: false);
            injector.PressKey(f23, down: false, scanCode, extended: false);
        });

        _output.WriteLine($"scan codes seen: {string.Join(", ", hook.Events.Select(e => e.ScanCode))}");
        Assert.Contains(hook.Events, e => e.VirtualKey == f23 && e.ScanCode == scanCode);
    }

    [Fact]
    public void Text_is_typed_as_unicode_rather_than_invented_keystrokes()
    {
        using var hook = new KeyboardHook();
        InjectionResult result = default;

        hook.Run(() => result = Injector().TypeText("é漢"));

        _output.WriteLine($"observed {hook.Events.Count} events for two characters");

        Assert.True(result.Injected, result.Reason);

        // Windows delivers an injected Unicode event as VK_PACKET with the character in the
        // scan code. Decomposing 'é' into keystrokes instead would depend on the remote
        // keyboard layout, which this side cannot know.
        Assert.Contains(hook.Events, e => e.VirtualKey == VkPacket && e.ScanCode == 'é');
        Assert.Contains(hook.Events, e => e.VirtualKey == VkPacket && e.ScanCode == '漢');
    }

    [Fact]
    public void A_newline_in_text_becomes_a_Return_key_rather_than_a_control_character()
    {
        using var hook = new KeyboardHook();
        hook.Run(() => Injector().TypeText("\n"));

        // Injecting U+000A as a Unicode character puts nothing in most text fields.
        Assert.Contains(hook.Events, e => e.VirtualKey == 0x0D);
        Assert.DoesNotContain(hook.Events, e => e.VirtualKey == VkPacket);
    }

    [Fact]
    public void Releasing_modifiers_sends_key_ups_for_every_one_of_them()
    {
        using var hook = new KeyboardHook();
        hook.Run(() => Injector().ReleaseAllModifiers());

        // Both sides of every modifier. Windows resolves a generic VK_CONTROL to the left
        // one, so releasing only the generic codes would leave a stuck right Ctrl stuck.
        int[] modifiers = { 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0x5B, 0x5C };

        _output.WriteLine($"released: {string.Join(", ", hook.Events.Select(e => e.VirtualKey))}");

        // A client that disconnects mid-chord would otherwise leave the remote machine with
        // a stuck Ctrl, and the next person at that keyboard finds every keystroke turning
        // into a shortcut.
        foreach (int modifier in modifiers)
        {
            Assert.Contains(hook.Events, e => e.VirtualKey == modifier && e.IsUp);
        }
    }

    [Fact]
    public void A_pointer_move_arrives_at_the_pixel_the_normalised_point_names()
    {
        using var hook = new MouseHook();
        InputInjector injector = Injector(Display(
            GetSystemMetrics(SmCxVirtualScreen),
            GetSystemMetrics(SmCyVirtualScreen),
            GetSystemMetrics(SmXVirtualScreen),
            GetSystemMetrics(SmYVirtualScreen)));

        InjectionResult result = default;
        hook.Run(() => result = injector.MovePointer(0.25, 0.75));

        Assert.True(result.Injected, result.Reason);
        Assert.NotEmpty(hook.Events);

        int expectedX = GetSystemMetrics(SmXVirtualScreen) +
            (int)Math.Round(0.25 * (GetSystemMetrics(SmCxVirtualScreen) - 1));
        int expectedY = GetSystemMetrics(SmYVirtualScreen) +
            (int)Math.Round(0.75 * (GetSystemMetrics(SmCyVirtualScreen) - 1));

        (int x, int y) = (hook.Events[0].X, hook.Events[0].Y);
        _output.WriteLine($"asked for ({expectedX}, {expectedY}), Windows delivered ({x}, {y})");

        // Within a pixel or two: the absolute range is 65536 steps across the whole virtual
        // desktop, so a wide desktop cannot address every pixel exactly.
        Assert.InRange(x, expectedX - 2, expectedX + 2);
        Assert.InRange(y, expectedY - 2, expectedY + 2);
        Assert.True(hook.Events[0].Injected);
    }

    [Fact]
    public void A_scroll_carries_one_wheel_notch_per_unit()
    {
        using var hook = new MouseHook();
        hook.Run(() => Injector().Scroll(0.5, 0.5, deltaX: 0, deltaY: -2));

        ObservedMouse? wheel = hook.Events.FirstOrDefault(e => e.Message == WmMouseWheel);
        _output.WriteLine($"wheel events: {hook.Events.Count(e => e.Message == WmMouseWheel)}");

        Assert.NotNull(wheel);

        // WHEEL_DELTA is 120 per notch, and the sign has to survive: scrolling down two
        // notches must not scroll up.
        Assert.Equal(-240, wheel!.Value.WheelDelta);
    }
}
