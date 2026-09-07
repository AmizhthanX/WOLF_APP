using System.Runtime.InteropServices;

// These names are Windows' own. `WaveFormatEx` is WAVEFORMATEX and `Stop` is
// IAudioClient::Stop, and the value of hand-written interop is that it can be read against
// the header it mirrors — renaming either to satisfy a naming rule would break exactly that.
#pragma warning disable CA1711 // Type name ends in 'Ex', as the Windows structure does.
#pragma warning disable CA1716 // Member named 'Stop', as the Windows interface does.

namespace Wolf.Agent.SessionHost.Audio;

/// <summary>
/// The slice of WASAPI needed to capture what a PC is playing.
///
/// Written out rather than taken from a library because it is small, stable, and this
/// process already runs as the signed-in user with access to their screen — every dependency
/// added here is more code with that access. The interfaces below are the four needed to
/// open the default output device in loopback mode and read the samples going to it.
///
/// Vtable order is the contract. A method declared in the wrong position calls the wrong
/// function, which is exactly the silent-corruption failure that makes hand-written interop
/// risky, so every interface here lists its methods in the order the header declares them —
/// including the ones WOLF never calls.
/// </summary>
[ComImport]
[Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
public class MMDeviceEnumerator
{
}

[ComImport]
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator
{
    void EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);

    /// <summary>dataFlow 0 is render, and the render endpoint is what loopback listens to.</summary>
    void GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
}

[ComImport]
[Guid("D666063F-1587-4E43-81F1-B948E807363F")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice
{
    void Activate(
        ref Guid iid,
        uint clsCtx,
        IntPtr activationParams,
        [MarshalAs(UnmanagedType.IUnknown)] out object iface);
}

[ComImport]
[Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioClient
{
    void Initialize(
        int shareMode,
        int streamFlags,
        long bufferDuration,
        long periodicity,
        IntPtr format,
        IntPtr sessionGuid);

    void GetBufferSize(out uint bufferFrames);

    void GetStreamLatency(out long latency);

    void GetCurrentPadding(out uint padding);

    void IsFormatSupported(int shareMode, IntPtr format, out IntPtr closestMatch);

    void GetMixFormat(out IntPtr format);

    void GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);

    void Start();

    void Stop();

    void Reset();

    void SetEventHandle(IntPtr handle);

    void GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
}

[ComImport]
[Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioCaptureClient
{
    void GetBuffer(
        out IntPtr data,
        out uint frames,
        out uint flags,
        out ulong devicePosition,
        out ulong qpcPosition);

    void ReleaseBuffer(uint frames);

    void GetNextPacketSize(out uint frames);
}

/// <summary>The fixed head of WAVEFORMATEX. Anything past it is read through `Size`.</summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public struct WaveFormatEx
{
    public ushort FormatTag;
    public ushort Channels;
    public uint SamplesPerSec;
    public uint AvgBytesPerSec;
    public ushort BlockAlign;
    public ushort BitsPerSample;
    public ushort Size;
}

internal static class WasapiConstants
{
    /// <summary>Capture what is being played rather than what a microphone hears.</summary>
    public const int StreamFlagsLoopback = 0x00020000;

    public const int ShareModeShared = 0;
    public const uint ClsCtxInprocServer = 1;

    /// <summary>Buffer duration, in 100-nanosecond units.</summary>
    public const long OneSecond = 10_000_000;

    /// <summary>AUDCLNT_BUFFERFLAGS_SILENT: the buffer holds nothing but silence.</summary>
    public const uint BufferFlagsSilent = 0x2;

    /// <summary>WAVE_FORMAT_IEEE_FLOAT, and the extensible tag that usually stands in for it.</summary>
    public const ushort FormatIeeeFloat = 3;
    public const ushort FormatExtensible = 0xFFFE;
    public const ushort FormatPcm = 1;
}
