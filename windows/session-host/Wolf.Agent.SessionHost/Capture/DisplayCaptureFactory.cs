using System.Runtime.Versioning;
using Microsoft.Extensions.Logging;
using SharpGen.Runtime;
using Vortice.DXGI;

namespace Wolf.Agent.SessionHost.Capture;

/// <summary>
/// Picks the way this machine can capture its screen.
///
/// Graphics Capture where it exists, Desktop Duplication where it does not. The order is not
/// a preference between two equivalent things: Graphics Capture composites the pointer,
/// draws the border that tells the person at the PC they are being watched, and survives a
/// resolution change without losing the output. Duplication is what is left on builds older
/// than Windows 10 1903, and a stream missing the cursor beats no stream at all.
///
/// Both are tried in turn rather than chosen from a version check alone: a build can report
/// Graphics Capture as supported and still refuse a particular display, and being told "this
/// PC cannot stream" by a machine that plainly can is the outcome worth avoiding.
/// </summary>
[SupportedOSPlatform("windows10.0.19041.0")]
public static class DisplayCaptureFactory
{
    /// <summary>
    /// Environment variable that forces the Desktop Duplication path.
    ///
    /// For the case the automatic choice cannot detect: a machine where Graphics Capture
    /// reports itself supported, starts without error, and then produces nothing usable —
    /// some virtual display drivers do exactly that. The fallback below only engages when
    /// starting fails outright, so without a way to say "use the other one" that machine has
    /// no path to a picture at all.
    ///
    /// Opt-in, and loud: it is a downgrade — no pointer in the image, and no border telling
    /// the person at the PC they are being watched — so it is logged as a warning every time
    /// it takes effect, and the capability handshake reports the API that will really be
    /// used rather than the better one.
    /// </summary>
    public const string ForceDuplicationVariable = "WOLF_FORCE_DESKTOP_DUPLICATION";

    /// <summary>True when this machine has been told to use Desktop Duplication regardless.</summary>
    public static bool DuplicationForced =>
        Environment.GetEnvironmentVariable(ForceDuplicationVariable) is "1" or "true" or "TRUE";

    /// <summary>
    /// Start capturing a monitor with whichever API works.
    ///
    /// <paramref name="preferDuplication"/> forces the fallback. It exists so the fallback
    /// can be tested on a machine that has Graphics Capture — otherwise it would only ever
    /// run on the machines least likely to be the ones being developed on, which is how a
    /// fallback rots.
    /// </summary>
    public static IDisplayCapture? TryStart(
        CaptureDevice device,
        IntPtr monitorHandle,
        ILoggerFactory loggers,
        bool preferDuplication = false)
    {
        ILogger log = loggers.CreateLogger(typeof(DisplayCaptureFactory));

        if (DuplicationForced && !preferDuplication)
        {
            log.LogWarning(
                "{Variable} is set, so this PC captures with Desktop Duplication: no mouse pointer " +
                "in the picture, and no capture indicator for the person at the PC.",
                ForceDuplicationVariable);
            preferDuplication = true;
        }

        if (!preferDuplication && CaptureDevice.IsCaptureSupported())
        {
            DisplayCapture? capture = DisplayCapture.TryStart(
                device,
                monitorHandle,
                loggers.CreateLogger<DisplayCapture>());

            if (capture is not null) return capture;

            log.LogWarning("Graphics Capture would not start for this display; trying Desktop Duplication.");
        }

        DuplicationCapture? duplication = DuplicationCapture.TryStart(
            device,
            monitorHandle,
            loggers.CreateLogger<DuplicationCapture>());

        if (duplication is not null) return duplication;

        log.LogError("Neither capture API could be started for this display.");
        return null;
    }

    /// <summary>
    /// Which API this machine would use, without starting a capture.
    ///
    /// Answered for the capability handshake, so it must not have side effects: starting a
    /// duplication to find out whether one is possible would take the single duplication
    /// Windows allows per output and hold it away from the real stream.
    ///
    /// Returns the protocol's names, or "none" when the machine cannot capture at all.
    /// </summary>
    public static string DetectApi()
    {
        if (!OperatingSystem.IsWindowsVersionAtLeast(10, 0, 19041)) return "none";

        // The override is answered here too. A handshake that advertised Graphics Capture on
        // a machine configured to use duplication would have the cloud promising a cursor
        // that is never going to arrive.
        if (!DuplicationForced && CaptureDevice.IsCaptureSupported()) return DisplayCapture.ApiName;

        // No Graphics Capture. Duplication needs an output that exposes IDXGIOutput1, which
        // every adapter driving a desktop does — so finding one is the honest answer to
        // "could this machine duplicate", short of taking a duplication to prove it.
        return HasDuplicableOutput() ? DuplicationCapture.ApiName : "none";
    }

    private static bool HasDuplicableOutput()
    {
        IDXGIFactory1? factory = null;

        try
        {
            factory = DXGI.CreateDXGIFactory1<IDXGIFactory1>();

            for (uint index = 0; ; index++)
            {
                if (factory.EnumAdapters1(index, out IDXGIAdapter1? adapter).Failure || adapter is null)
                {
                    return false;
                }

                using (adapter)
                {
                    for (uint outputIndex = 0; ; outputIndex++)
                    {
                        if (adapter.EnumOutputs(outputIndex, out IDXGIOutput? output).Failure || output is null)
                        {
                            break;
                        }

                        using (output)
                        {
                            if (!output.Description.AttachedToDesktop) continue;

                            using IDXGIOutput1? capable = output.QueryInterfaceOrNull<IDXGIOutput1>();
                            if (capable is not null) return true;
                        }
                    }
                }
            }
        }
        catch (SharpGenException)
        {
            // No DXGI at all. Whatever this machine is, it is not going to duplicate a
            // desktop, and saying "none" is the answer that stops the cloud offering it.
            return false;
        }
        finally
        {
            factory?.Dispose();
        }
    }
}
