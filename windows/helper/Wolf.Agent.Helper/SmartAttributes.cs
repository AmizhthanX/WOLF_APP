using Wolf.Agent.Core.Privileged;

namespace Wolf.Agent.Helper;

/// <summary>
/// Decodes the SMART attribute table a drive hands back.
///
/// The layout is fixed and ancient: a two-byte header, then up to thirty attributes of
/// twelve bytes each — id, a status word, the normalised value, the worst value ever seen,
/// six bytes of vendor-specific raw data, and a reserved byte. Windows wraps the whole thing
/// in an extra offset because it returns the buffer the driver filled rather than the
/// attribute table alone.
///
/// The *meanings* of the raw bytes are vendor-specific and always have been, which is why
/// only the handful with universally agreed meanings are interpreted here. The rest are
/// reported as the numbers the drive gave, because a wrong interpretation of somebody's disk
/// health is worse than an uninterpreted one.
/// </summary>
public static class SmartAttributes
{
    /// <summary>Bytes before the first attribute in the buffer Windows returns.</summary>
    private const int TableOffset = 2;

    private const int AttributeSize = 12;
    private const int MaxAttributes = 30;

    /// <summary>
    /// Attribute names that mean the same thing on every drive that reports them.
    ///
    /// Deliberately short. There are hundreds of vendor-specific ids and no authority on
    /// them; guessing produces confident labels on numbers that mean something else
    /// entirely. Anything not here is reported by its id.
    /// </summary>
    private static readonly Dictionary<int, string> KnownNames = new()
    {
        [1] = "Read error rate",
        [3] = "Spin-up time",
        [4] = "Start/stop count",
        [5] = "Reallocated sectors",
        [7] = "Seek error rate",
        [9] = "Power-on hours",
        [10] = "Spin retry count",
        [12] = "Power cycle count",
        [177] = "Wear levelling count",
        [179] = "Used reserved block count",
        [181] = "Program fail count",
        [182] = "Erase fail count",
        [187] = "Uncorrectable errors",
        [188] = "Command timeout",
        [190] = "Airflow temperature",
        [194] = "Temperature",
        [196] = "Reallocation events",
        [197] = "Pending sectors",
        [198] = "Uncorrectable sectors",
        [199] = "CRC error count",
        [231] = "SSD life left",
        [233] = "Media wearout indicator",
        [241] = "Total data written",
        [242] = "Total data read",
    };

    /// <summary>
    /// Attributes whose failure predicts the drive dying, rather than logging its wear.
    ///
    /// The drive itself says which in a status bit, and that is what is used. This set is
    /// the fallback for drives that leave the bit clear on attributes that plainly are
    /// pre-failure ones.
    /// </summary>
    private static readonly HashSet<int> PrefailIds = new() { 1, 3, 5, 7, 10, 184, 196, 197, 198, 201 };

    public static IReadOnlyList<HelperSmartAttribute> Parse(ReadOnlySpan<byte> buffer)
    {
        var attributes = new List<HelperSmartAttribute>();

        for (var index = 0; index < MaxAttributes; index++)
        {
            int offset = TableOffset + index * AttributeSize;
            if (offset + AttributeSize > buffer.Length) break;

            int id = buffer[offset];

            // Id zero is an empty slot, not an attribute. The table is fixed-size and drives
            // leave the unused entries blank rather than terminating the list.
            if (id == 0) continue;

            ushort status = (ushort)(buffer[offset + 1] | (buffer[offset + 2] << 8));
            int value = buffer[offset + 3];
            int worst = buffer[offset + 4];

            // Six bytes, little-endian. Read as a long because the wide ones — total bytes
            // written, power-on hours on some firmware — overflow anything smaller.
            long raw = 0;
            for (var byteIndex = 0; byteIndex < 6; byteIndex++)
            {
                raw |= (long)buffer[offset + 5 + byteIndex] << (8 * byteIndex);
            }

            // Bit 0 of the status word is the drive's own "this one predicts failure" flag.
            bool prefail = (status & 0x0001) != 0 || PrefailIds.Contains(id);

            attributes.Add(new HelperSmartAttribute(
                Id: id,
                Name: KnownNames.TryGetValue(id, out string? name) ? name : $"Attribute {id}",
                Value: value,
                Worst: worst,
                Threshold: 0,
                Raw: raw,
                Prefail: prefail,

                // Without a threshold table the drive has not told us what counts as failed,
                // so nothing is claimed to be failing. Thresholds arrive separately in
                // MSStorageDriver_FailurePredictThresholds and are merged by the caller.
                Failing: false));
        }

        return attributes;
    }

    /// <summary>
    /// Merge the vendor threshold table into attributes that were parsed without one.
    ///
    /// Separate because Windows exposes it as its own WMI class, and a drive can report
    /// attributes while refusing thresholds. An attribute whose threshold is unknown is not
    /// reported as failing — the honest reading of "the drive did not say".
    /// </summary>
    public static IReadOnlyList<HelperSmartAttribute> WithThresholds(
        IReadOnlyList<HelperSmartAttribute> attributes,
        ReadOnlySpan<byte> thresholdBuffer)
    {
        var thresholds = new Dictionary<int, int>();

        for (var index = 0; index < MaxAttributes; index++)
        {
            int offset = TableOffset + index * AttributeSize;
            if (offset + 2 > thresholdBuffer.Length) break;

            int id = thresholdBuffer[offset];
            if (id == 0) continue;
            thresholds[id] = thresholdBuffer[offset + 1];
        }

        if (thresholds.Count == 0) return attributes;

        var merged = new List<HelperSmartAttribute>(attributes.Count);

        foreach (HelperSmartAttribute attribute in attributes)
        {
            if (!thresholds.TryGetValue(attribute.Id, out int threshold) || threshold == 0)
            {
                // Threshold zero means the vendor set none for this attribute — it is a log,
                // not a health indicator, and can never be "past" anything.
                merged.Add(attribute);
                continue;
            }

            merged.Add(attribute with
            {
                Threshold = threshold,
                Failing = attribute.Value <= threshold,
            });
        }

        return merged;
    }

    /// <summary>Temperature in Celsius, from whichever attribute reports it.</summary>
    public static double? Temperature(IReadOnlyList<HelperSmartAttribute> attributes)
    {
        foreach (int id in new[] { 194, 190 })
        {
            HelperSmartAttribute? attribute = attributes.FirstOrDefault(candidate => candidate.Id == id);
            if (attribute is null) continue;

            // The low byte of the raw value is the temperature; the rest holds minimum and
            // maximum on some firmware and nothing at all on others.
            double celsius = (long)attribute.Raw & 0xFF;
            if (celsius is > 0 and < 120) return celsius;
        }

        return null;
    }

    /// <summary>Hours the drive has been powered on, when it reports them plausibly.</summary>
    public static double? PowerOnHours(IReadOnlyList<HelperSmartAttribute> attributes)
    {
        HelperSmartAttribute? hours = attributes.FirstOrDefault(attribute => attribute.Id == 9);
        if (hours is null) return null;

        // Some firmware reports minutes or seconds in this attribute. A drive that has been
        // on for nine hundred years has not; the number is in different units and reporting
        // it as hours would be worse than reporting nothing.
        return hours.Raw is > 0 and < 1_000_000 ? hours.Raw : null;
    }
}
