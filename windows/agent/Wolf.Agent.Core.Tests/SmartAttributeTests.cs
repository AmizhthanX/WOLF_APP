using Wolf.Agent.Core.Privileged;
using Wolf.Agent.Helper;
using Xunit;
using Xunit.Abstractions;

namespace Wolf.Agent.Core.Tests;

/// <summary>
/// Decoding the table a drive hands back about its own health.
///
/// This is the part of disk health that can be got wrong quietly. Reading the raw value as
/// four bytes instead of six turns a drive's power-on hours into nonsense; missing the
/// threshold merge reports a dying disk as fine. Neither produces an error — both produce a
/// confident wrong answer about whether somebody's data is safe.
///
/// The buffers here are built to the ATA layout rather than captured from a drive, which is
/// deliberate: a capture would test one vendor's firmware, and the failing cases — an
/// attribute past its threshold, a raw value that needs all six bytes — are exactly the ones
/// a healthy development machine will never produce.
///
/// Reading a real drive needs administrator, so it lives in the helper and is tested there
/// by a run that has it. What is checked here is everything that happens to the bytes after
/// they arrive.
/// </summary>
public sealed class SmartAttributeTests
{
    private readonly ITestOutputHelper _output;

    public SmartAttributeTests(ITestOutputHelper output)
    {
        _output = output;
    }

    /// <summary>Bytes before the first attribute, matching what the storage driver returns.</summary>
    private const int TableOffset = 2;

    private const int AttributeSize = 12;

    /// <summary>
    /// Build an attribute table the way a drive lays one out.
    ///
    /// Twelve bytes each: id, a two-byte status word, the normalised value, the worst value
    /// ever seen, six bytes of raw data, and one reserved byte.
    /// </summary>
    private static byte[] Table(params (int Id, int Value, int Worst, long Raw, bool Prefail)[] attributes)
    {
        var buffer = new byte[TableOffset + 30 * AttributeSize];

        for (var index = 0; index < attributes.Length; index++)
        {
            (int id, int value, int worst, long raw, bool prefail) = attributes[index];
            int offset = TableOffset + index * AttributeSize;

            buffer[offset] = (byte)id;
            buffer[offset + 1] = (byte)(prefail ? 0x01 : 0x00);
            buffer[offset + 2] = 0x00;
            buffer[offset + 3] = (byte)value;
            buffer[offset + 4] = (byte)worst;

            for (var byteIndex = 0; byteIndex < 6; byteIndex++)
            {
                buffer[offset + 5 + byteIndex] = (byte)((raw >> (8 * byteIndex)) & 0xFF);
            }
        }

        return buffer;
    }

    /// <summary>A threshold table: same stride, id then threshold.</summary>
    private static byte[] Thresholds(params (int Id, int Threshold)[] entries)
    {
        var buffer = new byte[TableOffset + 30 * AttributeSize];

        for (var index = 0; index < entries.Length; index++)
        {
            int offset = TableOffset + index * AttributeSize;
            buffer[offset] = (byte)entries[index].Id;
            buffer[offset + 1] = (byte)entries[index].Threshold;
        }

        return buffer;
    }

    [Fact]
    public void Attributes_are_read_with_their_values_and_raw_data()
    {
        byte[] table = Table(
            (Id: 5, Value: 100, Worst: 100, Raw: 0, Prefail: true),
            (Id: 9, Value: 95, Worst: 95, Raw: 14_236, Prefail: false),
            (Id: 194, Value: 62, Worst: 45, Raw: 38, Prefail: false));

        IReadOnlyList<HelperSmartAttribute> attributes = SmartAttributes.Parse(table);

        Assert.Equal(3, attributes.Count);

        HelperSmartAttribute hours = attributes.Single(attribute => attribute.Id == 9);
        Assert.Equal("Power-on hours", hours.Name);
        Assert.Equal(95, hours.Value);
        Assert.Equal(14_236, hours.Raw);

        // Id 5 is a pre-failure attribute both by the drive's own flag and by the fallback
        // list, so it must come back marked either way.
        Assert.True(attributes.Single(attribute => attribute.Id == 5).Prefail);
    }

    [Fact]
    public void Empty_slots_in_the_table_are_not_attributes()
    {
        // The table is a fixed thirty entries and drives leave the unused ones blank rather
        // than terminating the list. Reading them as attribute zero would report thirty
        // phantom entries on every drive.
        byte[] table = Table((Id: 12, Value: 99, Worst: 99, Raw: 421, Prefail: false));

        IReadOnlyList<HelperSmartAttribute> attributes = SmartAttributes.Parse(table);

        Assert.Single(attributes);
        Assert.Equal(12, attributes[0].Id);
    }

    [Fact]
    public void A_raw_value_that_needs_all_six_bytes_survives()
    {
        // Total bytes written on a drive that has been in service overflows four bytes. Read
        // narrowly, it silently wraps — and reports a nearly new SSD as ancient, or the
        // reverse.
        const long large = 0x0000_5544_3322_1100;

        byte[] table = Table((Id: 241, Value: 99, Worst: 99, Raw: large, Prefail: false));
        HelperSmartAttribute written = SmartAttributes.Parse(table).Single();

        _output.WriteLine($"raw {written.Raw:F0}, expected {large}");
        Assert.Equal(large, written.Raw);
    }

    [Fact]
    public void Nothing_is_reported_as_failing_until_the_drive_says_what_failed_means()
    {
        // A drive can report attributes and refuse thresholds. Without them there is no
        // basis for calling anything failing, and guessing one would either cry wolf or —
        // worse — miss a dying disk.
        byte[] table = Table((Id: 5, Value: 1, Worst: 1, Raw: 4_000, Prefail: true));

        HelperSmartAttribute attribute = SmartAttributes.Parse(table).Single();

        Assert.False(attribute.Failing);
        Assert.Equal(0, attribute.Threshold);
    }

    [Fact]
    public void An_attribute_at_or_below_its_threshold_is_failing()
    {
        byte[] table = Table(
            (Id: 5, Value: 10, Worst: 10, Raw: 2_048, Prefail: true),
            (Id: 9, Value: 95, Worst: 95, Raw: 14_236, Prefail: false));

        IReadOnlyList<HelperSmartAttribute> merged = SmartAttributes.WithThresholds(
            SmartAttributes.Parse(table),
            Thresholds((Id: 5, Threshold: 10), (Id: 9, Threshold: 0)));

        HelperSmartAttribute reallocated = merged.Single(attribute => attribute.Id == 5);
        HelperSmartAttribute hours = merged.Single(attribute => attribute.Id == 9);

        // At the threshold, not merely below it. A drive whose value has reached the number
        // the vendor called failure has failed by the vendor's own definition.
        Assert.True(reallocated.Failing);
        Assert.Equal(10, reallocated.Threshold);

        // Threshold zero means the vendor set none: the attribute is a log, not a health
        // indicator, and can never be past anything.
        Assert.False(hours.Failing);
    }

    [Fact]
    public void A_healthy_attribute_above_its_threshold_is_not_failing()
    {
        byte[] table = Table((Id: 5, Value: 100, Worst: 100, Raw: 0, Prefail: true));

        HelperSmartAttribute attribute = SmartAttributes
            .WithThresholds(SmartAttributes.Parse(table), Thresholds((Id: 5, Threshold: 10)))
            .Single();

        Assert.False(attribute.Failing);
        Assert.Equal(10, attribute.Threshold);
    }

    [Fact]
    public void Temperature_comes_from_the_low_byte_of_whichever_attribute_reports_it()
    {
        // Firmware packs minimum and maximum into the upper bytes of the same raw value, so
        // reading it whole reports a drive running at forty thousand degrees.
        byte[] table = Table((Id: 194, Value: 62, Worst: 45, Raw: 0x0037_0021_002A, Prefail: false));

        double? celsius = SmartAttributes.Temperature(SmartAttributes.Parse(table));

        _output.WriteLine($"temperature {celsius}");
        Assert.Equal(0x2A, celsius);
    }

    [Fact]
    public void An_implausible_temperature_is_reported_as_unknown()
    {
        byte[] table = Table((Id: 194, Value: 62, Worst: 45, Raw: 0, Prefail: false));

        // Zero is what a drive reports when it has no temperature sensor wired up, not a
        // drive at freezing point.
        Assert.Null(SmartAttributes.Temperature(SmartAttributes.Parse(table)));
    }

    [Fact]
    public void Power_on_hours_that_are_plainly_not_hours_are_not_reported()
    {
        // Some firmware puts minutes or seconds in this attribute. Nine hundred years of
        // uptime is the number in different units, and reporting it as hours would be worse
        // than reporting nothing.
        byte[] table = Table((Id: 9, Value: 99, Worst: 99, Raw: 8_000_000_000, Prefail: false));

        Assert.Null(SmartAttributes.PowerOnHours(SmartAttributes.Parse(table)));

        byte[] plausible = Table((Id: 9, Value: 99, Worst: 99, Raw: 14_236, Prefail: false));
        Assert.Equal(14_236, SmartAttributes.PowerOnHours(SmartAttributes.Parse(plausible)));
    }

    [Fact]
    public void An_attribute_with_no_agreed_meaning_is_reported_by_its_id()
    {
        // There are hundreds of vendor-specific ids and no authority on them. A confident
        // label on a number that means something else is worse than no label.
        byte[] table = Table((Id: 234, Value: 99, Worst: 99, Raw: 7, Prefail: false));

        Assert.Equal("Attribute 234", SmartAttributes.Parse(table).Single().Name);
    }

    [Fact]
    public void A_truncated_buffer_yields_what_it_contains_rather_than_throwing()
    {
        // A driver that returns a short buffer is a real thing, and this runs inside the
        // privileged service — an exception here would take down every operation on the PC,
        // not just this one.
        byte[] table = Table((Id: 5, Value: 100, Worst: 100, Raw: 0, Prefail: true));
        byte[] truncated = table[..(TableOffset + AttributeSize + 4)];

        IReadOnlyList<HelperSmartAttribute> attributes = SmartAttributes.Parse(truncated);

        Assert.Single(attributes);
        Assert.Equal(5, attributes[0].Id);
    }

    [Fact]
    public void An_empty_buffer_is_no_attributes_rather_than_a_failure()
    {
        Assert.Empty(SmartAttributes.Parse(Array.Empty<byte>()));
    }
}
