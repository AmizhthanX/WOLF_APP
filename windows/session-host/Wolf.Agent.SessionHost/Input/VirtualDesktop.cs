namespace Wolf.Agent.SessionHost.Input;

/// <summary>
/// The rectangle Windows lays every monitor out inside, in desktop pixels.
///
/// Not the same shape as a display. The origin can be negative — a second monitor placed to
/// the left of the primary one starts at a negative X, and one placed above it at a negative
/// Y — and every absolute pointer coordinate <c>SendInput</c> takes is a fraction of this
/// rectangle rather than of any one screen. Getting that wrong does not produce an error: it
/// produces clicks that land on the other monitor, which is reported as lag or as the remote
/// desktop being broken.
/// </summary>
public readonly record struct VirtualDesktop(int Left, int Top, int Width, int Height)
{
    /// <summary>The rightmost pixel column, inclusive.</summary>
    public int Right => Left + Width - 1;

    /// <summary>The bottom pixel row, inclusive.</summary>
    public int Bottom => Top + Height - 1;

    /// <summary>
    /// The smallest desktop that contains all of these displays.
    ///
    /// What Windows itself reports, derived rather than queried, so a layout can be stated
    /// in a test without the machine having to have those monitors plugged into it.
    /// </summary>
    public static VirtualDesktop Around(params (int OriginX, int OriginY, int Width, int Height)[] displays)
    {
        if (displays.Length == 0) return new VirtualDesktop(0, 0, 1, 1);

        int left = displays.Min(display => display.OriginX);
        int top = displays.Min(display => display.OriginY);
        int right = displays.Max(display => display.OriginX + display.Width);
        int bottom = displays.Max(display => display.OriginY + display.Height);

        return new VirtualDesktop(left, top, right - left, bottom - top);
    }
}
