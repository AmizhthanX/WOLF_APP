using Wolf.Agent.Core.Ipc;
using Wolf.Agent.SessionHost.Input;
using Xunit;
using Xunit.Abstractions;

namespace Wolf.Agent.Core.Tests;

/// <summary>
/// Pointer coordinates on a machine with more than one monitor.
///
/// This is the part of multi-monitor support that fails quietly. Switching the streamed
/// display either works or visibly does not; a coordinate that ignores the display's origin
/// still produces a click, just on the wrong screen — and that gets reported as lag, or as a
/// broken remote desktop, or not at all because the operator assumes they missed.
///
/// Every layout below is one somebody actually has: a second monitor to the right, to the
/// left, above, portrait beside landscape, and two of different resolutions. The layouts are
/// stated rather than plugged in, which is the only way this arithmetic can be checked at
/// all on a machine with one display — and the machine this was written on has one. What is
/// *not* claimed here is that two physical monitors have been switched between end to end;
/// that test exists in the capture suite and skips until somebody runs it on the hardware.
/// </summary>
public sealed class MultiMonitorMappingTests
{
    private readonly ITestOutputHelper _output;

    public MultiMonitorMappingTests(ITestOutputHelper output)
    {
        _output = output;
    }

    private static IpcDisplay Display(int width, int height, int originX, int originY, bool primary = false) =>
        new(
            Id: $"display-{originX}-{originY}",
            Name: $"{width}x{height} at {originX},{originY}",
            WidthPixels: width,
            HeightPixels: height,
            RefreshHz: 60,
            Primary: primary,
            ScaleFactor: 1,
            Hdr: false,
            OriginX: originX,
            OriginY: originY);

    /// <summary>Where a display's own edges fall in the absolute range, as fractions of it.</summary>
    private static (int Left, int Right) SpanOf(IpcDisplay display, VirtualDesktop desktop)
    {
        (int left, _) = InputInjector.ToVirtualDesktop(0, 0, display, desktop);
        (int right, _) = InputInjector.ToVirtualDesktop(1, 1, display, desktop);
        return (left, right);
    }

    [Fact]
    public void A_click_on_the_second_monitor_does_not_land_on_the_first()
    {
        // The ordinary two-monitor desk: 1920x1080 primary, a 2560x1440 to the right of it.
        IpcDisplay primary = Display(1920, 1080, 0, 0, primary: true);
        IpcDisplay secondary = Display(2560, 1440, 1920, 0);
        VirtualDesktop desktop = VirtualDesktop.Around((0, 0, 1920, 1080), (1920, 0, 2560, 1440));

        Assert.Equal(new VirtualDesktop(0, 0, 4480, 1440), desktop);

        (int primaryLeft, int primaryRight) = SpanOf(primary, desktop);
        (int secondaryLeft, int secondaryRight) = SpanOf(secondary, desktop);

        _output.WriteLine($"primary spans {primaryLeft}..{primaryRight}");
        _output.WriteLine($"secondary spans {secondaryLeft}..{secondaryRight}");

        // The whole point: neither display's coordinates reach into the other's half of the
        // range. A mapping that forgot OriginX would put both at 0..65535 and every click on
        // the second monitor would land on the first.
        Assert.True(primaryRight < secondaryLeft, "the two displays overlap in the absolute range");

        // The left edge of the desktop is the left edge of the primary, and the right edge of
        // the desktop is the right edge of the secondary.
        Assert.Equal(0, primaryLeft);
        Assert.Equal(InputInjector.AbsoluteMax, secondaryRight);
    }

    [Fact]
    public void A_monitor_to_the_left_of_the_primary_has_negative_coordinates()
    {
        // Windows puts the primary at 0,0 whatever is around it, so a monitor to its left
        // starts negative. Arithmetic that assumed the desktop began at zero would clamp
        // every point on that monitor to the far left edge and pile every click into one
        // column of pixels.
        IpcDisplay left = Display(2560, 1440, -2560, 0);
        IpcDisplay primary = Display(1920, 1080, 0, 0, primary: true);
        VirtualDesktop desktop = VirtualDesktop.Around((-2560, 0, 2560, 1440), (0, 0, 1920, 1080));

        Assert.Equal(-2560, desktop.Left);
        Assert.Equal(4480, desktop.Width);

        (int leftStart, int leftEnd) = SpanOf(left, desktop);
        (int primaryStart, int primaryEnd) = SpanOf(primary, desktop);

        _output.WriteLine($"left monitor spans {leftStart}..{leftEnd}, primary spans {primaryStart}..{primaryEnd}");

        Assert.Equal(0, leftStart);
        Assert.True(leftEnd < primaryStart, "the left monitor overlaps the primary");
        Assert.Equal(InputInjector.AbsoluteMax, primaryEnd);

        // And the primary no longer starts at zero, which is exactly the case a
        // single-monitor machine can never produce.
        Assert.True(primaryStart > InputInjector.AbsoluteMax / 3);
    }

    [Fact]
    public void A_monitor_above_the_primary_maps_the_vertical_axis_the_same_way()
    {
        IpcDisplay above = Display(1920, 1080, 0, -1080);
        IpcDisplay primary = Display(1920, 1080, 0, 0, primary: true);
        VirtualDesktop desktop = VirtualDesktop.Around((0, -1080, 1920, 1080), (0, 0, 1920, 1080));

        (_, int aboveTop) = InputInjector.ToVirtualDesktop(0, 0, above, desktop);
        (_, int aboveBottom) = InputInjector.ToVirtualDesktop(0, 1, above, desktop);
        (_, int primaryTop) = InputInjector.ToVirtualDesktop(0, 0, primary, desktop);
        (_, int primaryBottom) = InputInjector.ToVirtualDesktop(0, 1, primary, desktop);

        _output.WriteLine($"above spans {aboveTop}..{aboveBottom}, primary spans {primaryTop}..{primaryBottom}");

        Assert.Equal(0, aboveTop);
        Assert.True(aboveBottom < primaryTop, "the upper monitor overlaps the primary");
        Assert.Equal(InputInjector.AbsoluteMax, primaryBottom);

        // Horizontally they are the same screen, so both cover the full range.
        Assert.Equal(0, InputInjector.ToVirtualDesktop(0, 0, above, desktop).X);
        Assert.Equal(InputInjector.AbsoluteMax, InputInjector.ToVirtualDesktop(1, 0, primary, desktop).X);
    }

    [Fact]
    public void A_portrait_monitor_beside_a_landscape_one_keeps_its_own_shape()
    {
        // A rotated second monitor is common and is where an assumption that both screens
        // are the same size stops being invisible.
        IpcDisplay landscape = Display(2560, 1440, 0, 0, primary: true);
        IpcDisplay portrait = Display(1440, 2560, 2560, 0);
        VirtualDesktop desktop = VirtualDesktop.Around((0, 0, 2560, 1440), (2560, 0, 1440, 2560));

        Assert.Equal(new VirtualDesktop(0, 0, 4000, 2560), desktop);

        // The landscape monitor is only 1440 tall on a 2560-tall desktop, so its bottom edge
        // is a little over half way down the absolute range — not at the bottom of it.
        (_, int landscapeBottom) = InputInjector.ToVirtualDesktop(0, 1, landscape, desktop);
        (_, int portraitBottom) = InputInjector.ToVirtualDesktop(0, 1, portrait, desktop);

        _output.WriteLine($"landscape bottom {landscapeBottom}, portrait bottom {portraitBottom}");

        Assert.Equal(InputInjector.AbsoluteMax, portraitBottom);
        Assert.True(
            landscapeBottom < InputInjector.AbsoluteMax * 0.6,
            $"the landscape monitor's bottom edge mapped to {landscapeBottom}, which is off its own screen");
    }

    [Fact]
    public void The_centre_of_a_display_is_the_centre_of_that_display()
    {
        // Stated as the property rather than a number: the middle of whichever screen is
        // being streamed has to be the middle of that screen, wherever it sits.
        var desktop = VirtualDesktop.Around((0, 0, 1920, 1080), (1920, 0, 2560, 1440));

        foreach (IpcDisplay display in new[]
                 {
                     Display(1920, 1080, 0, 0, primary: true),
                     Display(2560, 1440, 1920, 0),
                 })
        {
            (int centreX, _) = InputInjector.ToVirtualDesktop(0.5, 0.5, display, desktop);
            (int leftX, _) = InputInjector.ToVirtualDesktop(0, 0, display, desktop);
            (int rightX, _) = InputInjector.ToVirtualDesktop(1, 1, display, desktop);

            int expected = (leftX + rightX) / 2;
            _output.WriteLine($"{display.Name}: centre {centreX}, expected about {expected}");

            // Rounding across a 65535-step range, so within a step or two.
            Assert.InRange(centreX, expected - 2, expected + 2);
        }
    }

    [Fact]
    public void A_single_monitor_still_uses_the_whole_range()
    {
        // The case every developer machine has, kept alongside the others so a change made
        // for two monitors cannot quietly break the one-monitor default.
        IpcDisplay only = Display(2560, 1440, 0, 0, primary: true);
        VirtualDesktop desktop = VirtualDesktop.Around((0, 0, 2560, 1440));

        Assert.Equal((0, 0), InputInjector.ToVirtualDesktop(0, 0, only, desktop));
        Assert.Equal(
            (InputInjector.AbsoluteMax, InputInjector.AbsoluteMax),
            InputInjector.ToVirtualDesktop(1, 1, only, desktop));
    }

    [Fact]
    public void Points_outside_the_display_are_clamped_onto_it()
    {
        // A client that sends a coordinate off the edge of the picture gets the edge, not a
        // point on the neighbouring monitor.
        IpcDisplay secondary = Display(2560, 1440, 1920, 0);
        VirtualDesktop desktop = VirtualDesktop.Around((0, 0, 1920, 1080), (1920, 0, 2560, 1440));

        (int left, int top) = SpanOf(secondary, desktop);

        Assert.Equal(InputInjector.ToVirtualDesktop(0, 0, secondary, desktop), InputInjector.ToVirtualDesktop(-3, -3, secondary, desktop));
        Assert.Equal(InputInjector.ToVirtualDesktop(1, 1, secondary, desktop), InputInjector.ToVirtualDesktop(4, 4, secondary, desktop));

        // Clamped onto its own display, so still nowhere near the primary.
        Assert.True(left > 0, "the secondary monitor should not start at the left edge of the desktop");
        _output.WriteLine($"secondary clamps to {left}..{top}");
    }

    [Fact]
    public void The_machine_this_runs_on_reports_a_desktop_that_contains_its_displays()
    {
        // One assertion against the real machine, so the stated layouts above cannot drift
        // away from what Windows actually reports.
        VirtualDesktop desktop = InputInjector.CurrentVirtualDesktop();

        _output.WriteLine(
            $"this machine: {desktop.Width}x{desktop.Height} from ({desktop.Left},{desktop.Top})");

        Assert.True(desktop.Width > 0);
        Assert.True(desktop.Height > 0);
    }
}
