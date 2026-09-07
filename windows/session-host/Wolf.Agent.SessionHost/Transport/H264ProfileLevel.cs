using System.Globalization;

namespace Wolf.Agent.SessionHost.Transport;

/// <summary>
/// The `profile-level-id` an SDP offer must carry, read out of the encoder's own sequence
/// parameter set.
///
/// This is derived rather than declared because the alternative is a constant that is wrong
/// on somebody's machine. A browser takes `profile-level-id` at its word: advertise
/// baseline 3.1 while sending high-profile 1440p and Chrome either refuses the format
/// outright or accepts it and renders nothing, with no error either side can act on.
///
/// The first three bytes after an SPS NAL header are exactly the three the field encodes —
/// `profile_idc`, the constraint flags, and `level_idc` — so the honest value is a
/// transcription, not a calculation.
/// </summary>
public static class H264ProfileLevel
{
    /// <summary>NAL unit type 7.</summary>
    private const int SequenceParameterSet = 7;

    /// <summary>
    /// Constrained baseline at level 3.1.
    ///
    /// Used only when the encoder published no parameter sets before the first frame, which
    /// some encoders do. It is the format every WebRTC implementation is required to
    /// support, so it is the safe thing to say when the truth is not yet known — and the
    /// first key frame carries the real parameter sets in-band moments later.
    /// </summary>
    public const string Fallback = "42e01f";

    /// <summary>
    /// Read `profile-level-id` from Annex-B parameter set bytes, or null if there is no SPS
    /// in them.
    /// </summary>
    public static string? FromParameterSets(ReadOnlySpan<byte> annexB)
    {
        foreach ((int start, int length) in NalUnits(annexB))
        {
            if (length < 4) continue;
            if ((annexB[start] & 0x1F) != SequenceParameterSet) continue;

            // Byte 0 is the NAL header; 1..3 are profile_idc, constraint flags, level_idc.
            return string.Create(
                6,
                (annexB[start + 1], annexB[start + 2], annexB[start + 3]),
                static (span, bytes) =>
                {
                    (byte profile, byte constraints, byte level) = bytes;
                    WriteHex(span[..2], profile);
                    WriteHex(span.Slice(2, 2), constraints);
                    WriteHex(span.Slice(4, 2), level);
                });
        }

        return null;
    }

    /// <summary>
    /// The fmtp line for an H.264 answer.
    ///
    /// `packetization-mode=1` because the packetiser sends fragmentation units, which is the
    /// only way a key frame larger than the MTU can cross the wire.
    /// `level-asymmetry-allowed=1` lets a client decode at a level other than the one it
    /// would encode at, which every browser wants and none of them state.
    /// </summary>
    public static string Fmtp(string profileLevelId) =>
        $"packetization-mode=1;level-asymmetry-allowed=1;profile-level-id={profileLevelId}";

    private static void WriteHex(Span<char> destination, byte value)
    {
        value.TryFormat(destination, out _, "x2", CultureInfo.InvariantCulture);
    }

    /// <summary>Walk Annex-B start codes, yielding the offset and length of each NAL unit.</summary>
    private static List<(int Start, int Length)> NalUnits(ReadOnlySpan<byte> data)
    {
        var starts = new List<int>();

        for (int index = 0; index + 2 < data.Length; index++)
        {
            if (data[index] != 0 || data[index + 1] != 0) continue;

            if (data[index + 2] == 1)
            {
                starts.Add(index + 3);
                index += 2;
            }
            else if (index + 3 < data.Length && data[index + 2] == 0 && data[index + 3] == 1)
            {
                starts.Add(index + 4);
                index += 3;
            }
        }

        var units = new List<(int, int)>(starts.Count);
        for (int i = 0; i < starts.Count; i++)
        {
            int end = i + 1 < starts.Count ? starts[i + 1] : data.Length;
            units.Add((starts[i], end - starts[i]));
        }

        return units;
    }
}
