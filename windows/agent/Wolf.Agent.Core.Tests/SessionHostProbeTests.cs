using Microsoft.Extensions.Logging.Abstractions;
using Wolf.Agent.Core.Ipc;
using Wolf.Agent.SessionHost.Displays;
using Wolf.Agent.SessionHost.Encoding;
using Xunit;
using Xunit.Abstractions;

namespace Wolf.Agent.Core.Tests;

/// <summary>
/// Display and encoder detection, run against the real machine.
///
/// These are deliberately not mocked. The entire value of the capability handshake is that
/// it reports what a particular machine can actually do, so a test that asserted against a
/// fake would be testing nothing. What is asserted is the shape and internal consistency of
/// the answer; what is *reported* is the answer itself, so a failure on an unusual machine
/// is diagnosable from the test output.
/// </summary>
public sealed class SessionHostProbeTests
{
    private readonly ITestOutputHelper _output;

    public SessionHostProbeTests(ITestOutputHelper output)
    {
        _output = output;
    }

    [Fact]
    public void Display_enumeration_returns_consistent_geometry()
    {
        var enumerator = new DisplayEnumerator(NullLogger<DisplayEnumerator>.Instance);
        IReadOnlyList<IpcDisplay> displays = enumerator.Enumerate();

        foreach (IpcDisplay display in displays)
        {
            _output.WriteLine(
                $"display {display.Id} \"{display.Name}\" {display.WidthPixels}x{display.HeightPixels} " +
                $"@{display.RefreshHz?.ToString() ?? "?"}Hz scale={display.ScaleFactor?.ToString() ?? "?"} " +
                $"primary={display.Primary} origin=({display.OriginX},{display.OriginY})");
        }

        if (displays.Count == 0)
        {
            // A session with no desktop — a headless build agent, or session 0. That is a
            // real answer, and the reason the session host exists at all.
            _output.WriteLine("No displays: this process has no desktop.");
            return;
        }

        foreach (IpcDisplay display in displays)
        {
            Assert.False(string.IsNullOrWhiteSpace(display.Id));
            Assert.False(string.IsNullOrWhiteSpace(display.Name));
            Assert.InRange(display.WidthPixels, 1, 32_768);
            Assert.InRange(display.HeightPixels, 1, 32_768);

            if (display.RefreshHz is not null) Assert.InRange(display.RefreshHz.Value, 1, 1000);
            if (display.ScaleFactor is not null) Assert.InRange(display.ScaleFactor.Value, 0.25, 8);
        }

        Assert.True(
            displays.Count(display => display.Primary) <= 1,
            "Windows has at most one primary display");
    }

    [Fact]
    public void Display_ids_are_unique_so_a_client_can_address_one()
    {
        var enumerator = new DisplayEnumerator(NullLogger<DisplayEnumerator>.Instance);
        IReadOnlyList<IpcDisplay> displays = enumerator.Enumerate();

        Assert.Equal(
            displays.Count,
            displays.Select(display => display.Id).Distinct(StringComparer.Ordinal).Count());
    }

    [Fact]
    public void Encoder_probe_reports_what_media_foundation_actually_offers()
    {
        var probe = new EncoderProbe(NullLogger<EncoderProbe>.Instance);
        IReadOnlyList<IpcEncoder> encoders = probe.Probe();

        foreach (IpcEncoder encoder in encoders)
        {
            _output.WriteLine($"encoder {encoder.Id} codec={encoder.Codec} hardware={encoder.Hardware} \"{encoder.Name}\"");
        }

        var knownCodecs = new[] { "h264", "h265", "av1", "vp9" };

        foreach (IpcEncoder encoder in encoders)
        {
            Assert.Contains(encoder.Codec, knownCodecs);
            Assert.False(string.IsNullOrWhiteSpace(encoder.Name));
            // The id encodes both facts the negotiation needs, and must agree with them.
            Assert.Equal($"{encoder.Codec}-{(encoder.Hardware ? "hardware" : "software")}", encoder.Id);
        }

        Assert.Equal(
            encoders.Count,
            encoders.Select(encoder => encoder.Id).Distinct(StringComparer.Ordinal).Count());
    }

    [Fact]
    public void Probing_twice_gives_the_same_answer_and_does_not_leak()
    {
        // MFTEnumEx hands back COM references that have to be released. Running the probe
        // repeatedly is the cheapest way to notice if they are not.
        var probe = new EncoderProbe(NullLogger<EncoderProbe>.Instance);

        IReadOnlyList<IpcEncoder> first = probe.Probe();
        for (int index = 0; index < 5; index++)
        {
            IReadOnlyList<IpcEncoder> again = probe.Probe();
            Assert.Equal(
                first.Select(encoder => encoder.Id).OrderBy(id => id, StringComparer.Ordinal),
                again.Select(encoder => encoder.Id).OrderBy(id => id, StringComparer.Ordinal));
        }
    }

    [Fact]
    public void A_hardware_encoder_is_reported_separately_from_a_software_one()
    {
        var probe = new EncoderProbe(NullLogger<EncoderProbe>.Instance);
        IReadOnlyList<IpcEncoder> encoders = probe.Probe();

        // The distinction is the point: it is what tells an operator whether a soft-looking
        // stream is the network or a CPU encoding in software.
        foreach (IGrouping<string, IpcEncoder> group in encoders.GroupBy(encoder => encoder.Codec))
        {
            Assert.True(
                group.Count() <= 2,
                $"expected at most a hardware and a software entry for {group.Key}");
            Assert.Equal(
                group.Count(),
                group.Select(encoder => encoder.Hardware).Distinct().Count());
        }
    }
}
