using System.Runtime.Versioning;
using Vortice.MediaFoundation;

namespace Wolf.Agent.SessionHost.Encoding;

/// <summary>
/// Starts and stops the Media Foundation platform, once per process.
///
/// Every Media Foundation object depends on the platform being started, and the shutdown is
/// process-wide: an encoder probe that started and stopped it would pull the ground out from
/// under a running encoder. Reference counting here means each component can say "I need the
/// platform" without knowing who else does.
///
/// This is not a nicety. Without <c>MFStartup</c>, enumeration and type negotiation appear
/// to succeed and the encoder then rejects every Direct3D surface it is given, with an error
/// that points at the surface rather than at the missing initialisation.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class MediaFoundationPlatform : IDisposable
{
    private static readonly object Gate = new();
    private static int _references;

    private bool _released;

    private MediaFoundationPlatform()
    {
    }

    /// <summary>Start the platform if it is not already running, and hold it open.</summary>
    public static MediaFoundationPlatform Acquire()
    {
        lock (Gate)
        {
            if (_references == 0)
            {
                MediaFactory.MFStartup(true).CheckError();
            }

            _references++;
            return new MediaFoundationPlatform();
        }
    }

    public void Dispose()
    {
        lock (Gate)
        {
            if (_released) return;
            _released = true;

            _references--;
            if (_references == 0)
            {
                MediaFactory.MFShutdown();
            }
        }
    }
}
