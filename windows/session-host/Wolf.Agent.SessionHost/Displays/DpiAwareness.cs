using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Wolf.Agent.SessionHost.Displays;

/// <summary>
/// Makes this process see displays in real pixels.
///
/// Without this, Windows lies to the process for its own good: a DPI-unaware program is
/// told a 2560x1440 monitor at 125% scaling is 2048x1152, and is handed a scale factor of
/// 1.0. That is exactly wrong for a remote desktop:
///
///   * The display list shows the operator a resolution the monitor does not have.
///   * Capture returns real pixels regardless, so the stream is 2560x1440 while the client
///     has been told to expect 2048x1152.
///   * Normalised pointer coordinates map onto the wrong pixel, and the gap grows with the
///     scale factor.
///
/// Declaring per-monitor awareness makes every display API report physical pixels and the
/// true per-monitor DPI, which is the only basis on which capture and input can agree.
/// </summary>
[SupportedOSPlatform("windows")]
public static class DpiAwareness
{
    /// <summary>DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2.</summary>
    private static readonly IntPtr PerMonitorAwareV2 = new(-4);

    private static int _state;

    /// <summary>
    /// Declare per-monitor DPI awareness for this process.
    ///
    /// Idempotent and safe to call from anywhere: the setting is process-wide and can only
    /// be established once, so a second call — or a manifest that already set it — simply
    /// reports that it is already in effect.
    /// </summary>
    public static bool EnsurePerMonitorAware()
    {
        if (Interlocked.Exchange(ref _state, 1) == 1)
        {
            return true;
        }

        if (SetProcessDpiAwarenessContext(PerMonitorAwareV2))
        {
            return true;
        }

        int error = Marshal.GetLastWin32Error();

        // ERROR_ACCESS_DENIED means awareness was already set, by a manifest or an earlier
        // call. That is success as far as the caller is concerned.
        const int accessDenied = 5;
        return error == accessDenied;
    }

#pragma warning disable SYSLIB1054 // A single boolean entry point; the generator adds nothing.
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
#pragma warning restore SYSLIB1054
}
