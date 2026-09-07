using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Microsoft.Extensions.Logging;
using Wolf.Agent.Core.Ipc;

namespace Wolf.Agent.SessionHost.Encoding;

/// <summary>
/// Discovers which video encoders this machine actually has.
///
/// This is the foundation of WOLF's honest capability reporting. The cloud refuses to
/// negotiate a codec the PC cannot encode, and the only way to know what a PC can encode is
/// to ask Media Foundation which transforms are registered — not to assume that a GPU of a
/// given brand implies a given encoder, which is wrong often enough to matter.
///
/// The probe asks twice per codec, for two disjoint families: hardware transforms, and
/// software ones. That distinction is what tells an operator whether a soft-looking stream
/// is the network or a CPU encoding H.264 in software.
///
/// Only presence is detected, not the vendor name. Reading the friendly name means calling
/// through <c>IMFAttributes</c>, whose vtable this code would have to lay out by hand; the
/// name is a diagnostic nicety and not worth that risk, so encoders are reported as
/// "h264-hardware" rather than "Intel Quick Sync Video H.264 Encoder".
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class EncoderProbe
{
    private readonly ILogger<EncoderProbe> _logger;

    public EncoderProbe(ILogger<EncoderProbe> logger)
    {
        _logger = logger;
    }

    /// <summary>Codecs WOLF can offer, paired with their Media Foundation subtype. </summary>
    private static readonly (string Codec, Guid Subtype, string Label)[] Candidates =
    {
        ("h264", MakeFourCcGuid("H264"), "H.264"),
        ("h265", MakeFourCcGuid("HEVC"), "H.265 / HEVC"),
        ("av1", MakeFourCcGuid("AV01"), "AV1"),
        ("vp9", MakeFourCcGuid("VP90"), "VP9"),
    };

    public IReadOnlyList<IpcEncoder> Probe()
    {
        var encoders = new List<IpcEncoder>();

        MediaFoundationPlatform platform;
        try
        {
            platform = MediaFoundationPlatform.Acquire();
        }
        catch (Exception ex) when (ex is SharpGen.Runtime.SharpGenException or DllNotFoundException)
        {
            _logger.LogWarning(
                "Media Foundation could not be started; no encoders will be reported: {Message}",
                ex.Message);
            return encoders;
        }

        try
        {
            foreach ((string codec, Guid subtype, string label) in Candidates)
            {
                // The two queries are disjoint, not nested: omitting MFT_ENUM_FLAG_HARDWARE
                // excludes hardware transforms rather than including everything. Each result
                // therefore stands on its own, and a machine with both gets both reported —
                // which matters, because the software entry is the fallback the negotiation
                // uses when the hardware encoder is busy or refuses the requested profile.
                if (CountTransforms(subtype, hardware: true) > 0)
                {
                    encoders.Add(new IpcEncoder(
                        Id: $"{codec}-hardware",
                        Codec: codec,
                        Name: $"{label} (hardware)",
                        Hardware: true));
                }

                if (CountTransforms(subtype, hardware: false) > 0)
                {
                    encoders.Add(new IpcEncoder(
                        Id: $"{codec}-software",
                        Codec: codec,
                        Name: $"{label} (software)",
                        Hardware: false));
                }
            }
        }
        finally
        {
            // Reference counted: this releases the probe's own hold without shutting the
            // platform down under an encoder that is still running.
            platform.Dispose();
        }

        _logger.LogInformation(
            "Detected {Count} video encoder(s): {Encoders}",
            encoders.Count,
            string.Join(", ", encoders.Select(encoder => encoder.Id)));

        return encoders;
    }

    /// <summary>
    /// Count registered encoder transforms producing a given subtype, in exactly one of the
    /// two families.
    ///
    /// The returned array is COM-allocated and holds references; both the references and
    /// the array have to be released, or every probe leaks.
    /// </summary>
    private int CountTransforms(Guid outputSubtype, bool hardware)
    {
        var outputType = new MftRegisterTypeInfo
        {
            guidMajorType = MfMediaTypeVideo,
            guidSubtype = outputSubtype,
        };

        uint flags = hardware
            ? MftEnumFlagHardware | MftEnumFlagAsyncMft | MftEnumFlagSortAndFilter
            : MftEnumFlagSyncMft | MftEnumFlagAsyncMft | MftEnumFlagSortAndFilter;

        IntPtr activateArray = IntPtr.Zero;
        try
        {
            int result = MFTEnumEx(
                MftCategoryVideoEncoder,
                flags,
                IntPtr.Zero,
                ref outputType,
                out activateArray,
                out uint count);

            if (result != 0)
            {
                _logger.LogDebug(
                    "MFTEnumEx failed for {Subtype} (0x{Hresult:X8}).",
                    outputSubtype,
                    result);
                return 0;
            }

            ReleaseActivates(activateArray, count);
            return (int)count;
        }
        catch (DllNotFoundException)
        {
            // Media Foundation is absent on Windows N editions without the media pack.
            _logger.LogWarning("Media Foundation is not installed; no encoders can be detected.");
            return 0;
        }
        finally
        {
            if (activateArray != IntPtr.Zero) CoTaskMemFree(activateArray);
        }
    }

    private static void ReleaseActivates(IntPtr array, uint count)
    {
        if (array == IntPtr.Zero) return;

        for (uint index = 0; index < count; index++)
        {
            IntPtr activate = Marshal.ReadIntPtr(array, (int)(index * (uint)IntPtr.Size));
            if (activate != IntPtr.Zero) Marshal.Release(activate);
        }
    }

    /// <summary>
    /// Media Foundation subtype GUIDs are a FOURCC followed by a fixed suffix, so they can
    /// be built rather than hard-coded one constant at a time.
    /// </summary>
    private static Guid MakeFourCcGuid(string fourCc)
    {
        if (fourCc.Length != 4) throw new ArgumentException("A FOURCC is four characters.", nameof(fourCc));

        uint value = (uint)(fourCc[0] | (fourCc[1] << 8) | (fourCc[2] << 16) | (fourCc[3] << 24));
        return new Guid(
            value,
            0x0000,
            0x0010,
            0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71);
    }

    // -------------------------------------------------------------------------
    // Interop
    // -------------------------------------------------------------------------

    private const uint MftEnumFlagSyncMft = 0x00000001;
    private const uint MftEnumFlagAsyncMft = 0x00000002;
    private const uint MftEnumFlagHardware = 0x00000004;
    private const uint MftEnumFlagSortAndFilter = 0x00000040;

    private static readonly Guid MftCategoryVideoEncoder =
        new("f79eac7d-e545-4387-bdee-d647d7bde42a");

    private static readonly Guid MfMediaTypeVideo =
        new("73646976-0000-0010-8000-00aa00389b71");

    [StructLayout(LayoutKind.Sequential)]
    private struct MftRegisterTypeInfo
    {
        public Guid guidMajorType;
        public Guid guidSubtype;
    }

#pragma warning disable SYSLIB1054 // GUID-by-value and out-array marshalling.
    [DllImport("mfplat.dll", ExactSpelling = true)]
    private static extern int MFTEnumEx(
        Guid guidCategory,
        uint flags,
        IntPtr pInputType,
        ref MftRegisterTypeInfo pOutputType,
        out IntPtr pppMFTActivate,
        out uint pnumMFTActivate);

    [DllImport("ole32.dll")]
    private static extern void CoTaskMemFree(IntPtr ptr);
#pragma warning restore SYSLIB1054
}
