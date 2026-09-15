using Wolf.Agent.SessionHost.Encoding;
using Xunit;

namespace Wolf.Agent.Core.Tests;

/// <summary>
/// Which H.264 profile a stream is encoded in.
///
/// The rule has one job: never send a client a profile it said it cannot decode, and change nothing for a
/// client that did not say.
/// </summary>
public sealed class H264ProfileChoiceTests
{
    [Fact]
    public void A_client_that_states_nothing_gets_high_as_before()
    {
        Assert.Equal("high", Chosen(null));
        Assert.Equal("high", Chosen(Array.Empty<string>()));
    }

    [Fact]
    public void High_is_used_whenever_the_client_can_decode_it()
    {
        Assert.Equal("high", Chosen(new[] { "constrained-baseline", "high" }));
    }

    [Fact]
    public void A_client_without_high_gets_the_best_profile_it_lists()
    {
        Assert.Equal("main", Chosen(new[] { "main", "constrained-baseline" }));
        // The Android emulator's only H.264 decoder.
        Assert.Equal("constrained-baseline", Chosen(new[] { "constrained-baseline" }));
    }

    [Fact]
    public void A_client_listing_nothing_this_host_can_produce_gets_no_profile()
    {
        Assert.Null(H264ProfileChoice.Choose(new[] { "high-10" }));
    }

    private static string Chosen(IReadOnlyList<string>? clientProfiles) =>
        H264ProfileChoice.Describe(H264ProfileChoice.Choose(clientProfiles)!.Value);
}
