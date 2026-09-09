using Wolf.Agent.SessionHost.Adaptation;
using Xunit;
using Xunit.Abstractions;

namespace Wolf.Agent.Core.Tests;

/// <summary>
/// The adaptation policy, driven through sequences of conditions.
///
/// Adaptation is the part of a remote desktop that is hardest to check by using it: a
/// congested link is not something you can arrange on demand, and the failure mode of a bad
/// controller — oscillating between sharp and unwatchable — takes minutes to recognise and
/// is easy to blame on the network. So the policy is a pure function of measurements, and
/// these tests feed it the conditions that matter.
///
/// What is being asserted throughout is the PRD's order of concessions: bitrate first,
/// because a bitrate change is invisible; frame rate second, because it is noticeable but
/// harmless; resolution last, because it costs a new encoder, a key frame, and a visible
/// re-layout of everything the operator is looking at. And never a silent failure to meet
/// the profile, because an operator who cannot see that the stream is degraded will go
/// looking for the problem somewhere else.
/// </summary>
public sealed class RateControllerTests
{
    private readonly ITestOutputHelper _output;

    public RateControllerTests(ITestOutputHelper output)
    {
        _output = output;
    }

    private const int Max = 20_000_000;
    private const int Min = 2_000_000;

    private static RateController Controller(bool adaptive = true, int targetFps = 60) =>
        new(new RateLimits(Min, Max, targetFps, adaptive));

    /// <summary>A controller with individual levers taken away from adaptation.</summary>
    private static RateController Pinned(
        int? bitrate = null,
        int? frameRate = null,
        double? scale = null,
        int targetFps = 60) =>
        new(new RateLimits(Min, Max, targetFps, true, bitrate, frameRate, scale));

    /// <summary>An interval bad enough that every free lever should be reaching for something.</summary>
    private static RateSignals Terrible() => Losing(30, estimate: 400_000);

    /// <summary>A healthy interval: nothing lost, plenty of headroom, encoder idling.</summary>
    private static RateSignals Healthy(int? estimate = 40_000_000) =>
        new(estimate, 0, 20, EncodeMsPerFrame: 1, CapturedFps: 60, EncodedFps: 60);

    private static RateSignals Losing(double percent, int? estimate = 40_000_000) =>
        new(estimate, percent, 60, EncodeMsPerFrame: 1, CapturedFps: 60, EncodedFps: 60);

    /* --------------------------------------------------------------------- */
    /* Coming down                                                            */
    /* --------------------------------------------------------------------- */

    [Fact]
    public void A_stream_starts_at_the_ceiling_the_profile_asked_for()
    {
        RateController controller = Controller();

        Assert.Equal(Max, controller.BitrateBps);
        Assert.Equal(60, controller.FrameRate);

        // And says nothing is wrong, because nothing is.
        RateDecision decision = controller.Observe(Healthy());
        Assert.Null(decision.DegradedReason);
    }

    [Fact]
    public void Loss_lowers_the_bitrate_and_names_loss_as_the_reason()
    {
        RateController controller = Controller();

        RateDecision decision = controller.Observe(Losing(5));

        _output.WriteLine($"{Max} -> {decision.BitrateBps} on 5% loss");

        Assert.True(decision.BitrateChanged);
        Assert.True(decision.BitrateBps < Max);
        Assert.Equal("packet-loss", decision.DegradedReason);

        // Frame rate is untouched: it is the second lever, not the first.
        Assert.False(decision.FrameRateChanged);
        Assert.Equal(60, decision.FrameRate);
    }

    [Fact]
    public void Severe_loss_is_cut_harder_than_mild_loss()
    {
        RateController mild = Controller();
        RateController severe = Controller();

        int afterMild = mild.Observe(Losing(3)).BitrateBps;
        int afterSevere = severe.Observe(Losing(25)).BitrateBps;

        _output.WriteLine($"3% loss -> {afterMild}, 25% loss -> {afterSevere}");

        // A link dropping a quarter of the packets needs to be got off quickly; one dropping
        // three percent needs a nudge, not a collapse.
        Assert.True(afterSevere < afterMild);
    }

    [Fact]
    public void The_congestion_estimate_caps_the_bitrate_below_it()
    {
        RateController controller = Controller();

        RateDecision decision = controller.Observe(Healthy(estimate: 5_000_000));

        _output.WriteLine($"estimate 5 Mbps -> {decision.BitrateBps}");

        // Under the estimate, not at it: a stream riding exactly on the estimate has no
        // headroom for a key frame, and a key frame is where congestion starts.
        Assert.True(decision.BitrateBps < 5_000_000);
        Assert.Equal("bandwidth", decision.DegradedReason);
    }

    [Fact]
    public void With_no_estimate_yet_the_stream_is_not_held_back_by_a_guess()
    {
        RateController controller = Controller();

        // Congestion control has not spoken. Assuming a number here would either throttle a
        // fast link for no reason or flood a slow one.
        RateDecision decision = controller.Observe(Healthy(estimate: null));

        Assert.Equal(Max, decision.BitrateBps);
        Assert.Null(decision.DegradedReason);
    }

    [Fact]
    public void An_encoder_that_cannot_keep_up_costs_frame_rate_not_bitrate()
    {
        RateController controller = Controller();

        // 30 ms per frame against a 16.7 ms budget at 60 fps. No bitrate change fixes this.
        RateDecision decision = controller.Observe(
            new RateSignals(40_000_000, 0, 20, EncodeMsPerFrame: 30, CapturedFps: 60, EncodedFps: 40));

        _output.WriteLine($"encoder overloaded -> {decision.FrameRate} fps, {decision.BitrateBps} bps");

        Assert.True(decision.FrameRateChanged);
        Assert.True(decision.FrameRate < 60);
        Assert.Equal("encoder-overloaded", decision.DegradedReason);
    }

    [Fact]
    public void Capture_falling_behind_is_reported_rather_than_treated_as_congestion()
    {
        RateController controller = Controller();

        // The encoder is fast and the link is clean; the screen simply is not producing
        // frames. Lowering the bitrate would make the picture worse and change nothing.
        RateDecision decision = controller.Observe(
            new RateSignals(40_000_000, 0, 20, EncodeMsPerFrame: 1, CapturedFps: 12, EncodedFps: 12));

        Assert.Equal("capture-slow", decision.DegradedReason);
        Assert.False(decision.BitrateChanged);
        Assert.False(decision.FrameRateChanged);
    }

    [Fact]
    public void The_bitrate_never_falls_below_the_floor_however_bad_it_gets()
    {
        RateController controller = Controller();

        for (int interval = 0; interval < 60; interval++)
        {
            controller.Observe(Losing(40, estimate: 100_000));
        }

        _output.WriteLine($"after 60 intervals of 40% loss: {controller.BitrateBps} bps");

        // Below this a 1440p stream is not a picture. Continuing to halve would produce a
        // connection that is technically alive and of no use to anyone.
        Assert.Equal(RateLimits.AbsoluteFloorBps, controller.BitrateBps);
    }

    [Fact]
    public void Running_under_the_operators_floor_is_reported_as_degraded()
    {
        RateController controller = Controller();

        RateDecision decision = controller.Observe(Healthy(estimate: 800_000));

        _output.WriteLine($"{decision.BitrateBps} bps against a {Min} floor: {decision.DegradedReason}");

        // The profile said not to go below 2 Mbps. The link says otherwise, and a working
        // low-quality stream beats a broken high-quality one — but the operator is told the
        // profile they chose is not currently possible.
        Assert.True(decision.BitrateBps < Min);
        Assert.NotNull(decision.DegradedReason);
    }

    /* --------------------------------------------------------------------- */
    /* Going back up                                                          */
    /* --------------------------------------------------------------------- */

    [Fact]
    public void Recovery_waits_for_several_clean_intervals_before_giving_anything_back()
    {
        RateController controller = Controller();
        int reduced = controller.Observe(Losing(15)).BitrateBps;

        // One clean interval is not evidence: loss arrives in bursts, and probing after the
        // first quiet second is how a stream ends up oscillating.
        int afterOne = controller.Observe(Healthy()).BitrateBps;
        Assert.Equal(reduced, afterOne);

        int last = afterOne;
        for (int interval = 0; interval < 5; interval++)
        {
            last = controller.Observe(Healthy()).BitrateBps;
        }

        _output.WriteLine($"reduced to {reduced}, recovered to {last}");
        Assert.True(last > reduced);
    }

    [Fact]
    public void Recovery_climbs_gradually_rather_than_jumping_back_to_the_ceiling()
    {
        RateController controller = Controller();
        int reduced = controller.Observe(Losing(30)).BitrateBps;

        int afterFirstStep = reduced;
        for (int interval = 0; interval < 4; interval++)
        {
            afterFirstStep = controller.Observe(Healthy()).BitrateBps;
        }

        _output.WriteLine($"{reduced} -> {afterFirstStep} after one recovery step");

        // Going straight back to the ceiling would recreate the congestion that caused the
        // cut, which is the oscillation this is designed to avoid.
        Assert.True(afterFirstStep > reduced);
        Assert.True(afterFirstStep < Max);
    }

    [Fact]
    public void Bitrate_is_restored_before_frame_rate()
    {
        RateController controller = Controller();

        // Push both levers down: an overloaded encoder on a lossy link.
        controller.Observe(new RateSignals(2_000_000, 20, 200, 40, 60, 20));
        int loweredFps = controller.FrameRate;
        int loweredBitrate = controller.BitrateBps;
        Assert.True(loweredFps < 60);

        // Now everything is clean again. Bitrate should come back while the frame rate is
        // still held, because a smooth soft picture is easier to work in than a sharp
        // stuttering one.
        for (int interval = 0; interval < 4; interval++) controller.Observe(Healthy());

        _output.WriteLine(
            $"after recovery: {controller.BitrateBps} bps (was {loweredBitrate}), " +
            $"{controller.FrameRate} fps (was {loweredFps})");

        Assert.True(controller.BitrateBps > loweredBitrate);
        Assert.Equal(loweredFps, controller.FrameRate);
    }

    [Fact]
    public void A_long_clean_run_returns_to_the_profile_and_stops_reporting_degradation()
    {
        RateController controller = Controller();
        controller.Observe(Losing(20));

        RateDecision decision = controller.Observe(Healthy());
        for (int interval = 0; interval < 200; interval++)
        {
            decision = controller.Observe(Healthy());
        }

        _output.WriteLine($"settled at {decision.BitrateBps} bps, {decision.FrameRate} fps");

        Assert.Equal(Max, decision.BitrateBps);
        Assert.Equal(60, decision.FrameRate);
        Assert.Null(decision.DegradedReason);
    }

    [Fact]
    public void A_steady_link_does_not_make_the_controller_fidget()
    {
        RateController controller = Controller();

        // A link that holds at 8 Mbps. The stream should settle just under it and stay
        // there, rather than climbing into the loss it just backed away from.
        var settled = new List<int>();
        for (int interval = 0; interval < 40; interval++)
        {
            settled.Add(controller.Observe(Healthy(estimate: 8_000_000)).BitrateBps);
        }

        int highest = settled.Skip(10).Max();
        int lowest = settled.Skip(10).Min();

        _output.WriteLine($"settled between {lowest} and {highest} against an 8 Mbps path");

        Assert.True(highest <= 8_000_000);
        Assert.Equal(lowest, highest);
    }

    /* --------------------------------------------------------------------- */
    /* Resolution, the last lever                                             */
    /* --------------------------------------------------------------------- */

    [Fact]
    public void Resolution_is_untouched_while_the_other_two_levers_have_room()
    {
        RateController controller = Controller();

        RateDecision decision = controller.Observe(Losing(30, estimate: 1_000_000));

        // Bitrate came down, and resolution did not. A resolution change costs a new
        // encoder, a key frame, and a visible re-layout, so it is not spent on the first
        // sign of trouble.
        Assert.True(decision.BitrateChanged);
        Assert.False(decision.ResolutionChanged);
        Assert.Equal(1.0, decision.ResolutionScale);
    }

    [Fact]
    public void Resolution_falls_only_once_bitrate_and_frame_rate_are_exhausted()
    {
        RateController controller = Controller();

        // A link that has collapsed and an encoder that cannot cope. Both other levers run
        // out within a few intervals; only then is resolution touched.
        RateDecision decision = controller.Observe(Healthy());
        for (int interval = 0; interval < 30; interval++)
        {
            decision = controller.Observe(new RateSignals(150_000, 35, 400, 90, 60, 8));
        }

        _output.WriteLine(
            $"after a sustained collapse: {decision.BitrateBps} bps, {decision.FrameRate} fps, " +
            $"{decision.ResolutionScale:P0} of full size");

        Assert.Equal(RateLimits.AbsoluteFloorBps, decision.BitrateBps);
        Assert.Equal(RateLimits.FrameRateLadder[^1], decision.FrameRate);
        Assert.True(decision.ResolutionScale < 1.0);
    }

    [Fact]
    public void Resolution_never_falls_below_half_size()
    {
        RateController controller = Controller();

        for (int interval = 0; interval < 200; interval++)
        {
            controller.Observe(new RateSignals(100_000, 60, 900, 200, 60, 2));
        }

        _output.WriteLine($"floor: {controller.ResolutionScale:P0} of full size");

        // Below half, the text on a remote desktop stops being readable, and an unreadable
        // desktop is not a degraded stream — it is a useless one.
        Assert.Equal(RateLimits.ResolutionLadder[^1], controller.ResolutionScale);
    }

    [Fact]
    public void Resolution_comes_back_before_frame_rate()
    {
        RateController controller = Controller();

        for (int interval = 0; interval < 30; interval++)
        {
            controller.Observe(new RateSignals(150_000, 35, 400, 90, 60, 8));
        }

        double loweredScale = controller.ResolutionScale;
        int loweredFps = controller.FrameRate;
        Assert.True(loweredScale < 1.0);
        Assert.Equal(RateLimits.FrameRateLadder[^1], loweredFps);

        // Everything is clean again. Bitrate climbs first, then resolution — a remote
        // desktop is mostly read, and text too soft to make out cannot be worked around
        // while a slower refresh can.
        double scaleWhenRestored = loweredScale;
        int fpsWhenScaleRestored = loweredFps;

        for (int interval = 0; interval < 400; interval++)
        {
            controller.Observe(Healthy());

            if (controller.ResolutionScale > scaleWhenRestored)
            {
                scaleWhenRestored = controller.ResolutionScale;
                fpsWhenScaleRestored = controller.FrameRate;
            }
        }

        _output.WriteLine(
            $"resolution reached {scaleWhenRestored:P0} while the frame rate was still " +
            $"{fpsWhenScaleRestored} fps; settled at {controller.FrameRate} fps");

        Assert.Equal(1.0, controller.ResolutionScale);
        Assert.Equal(60, controller.FrameRate);
        Assert.Equal(RateLimits.FrameRateLadder[^1], fpsWhenScaleRestored);
    }

    /* --------------------------------------------------------------------- */
    /* A pinned profile                                                       */
    /* --------------------------------------------------------------------- */

    [Fact]
    public void A_pinned_profile_is_left_alone_even_on_a_bad_link()
    {
        RateController controller = Controller(adaptive: false);

        RateDecision decision = controller.Observe(Losing(30, estimate: 500_000));

        _output.WriteLine($"pinned: {decision.BitrateBps} bps, reason {decision.DegradedReason}");

        // The operator asked for these numbers. Overriding the choice quietly would be
        // deciding for them that they were wrong.
        Assert.Equal(Max, decision.BitrateBps);
        Assert.False(decision.BitrateChanged);
        Assert.False(decision.FrameRateChanged);
        Assert.False(decision.ResolutionChanged);
        Assert.Equal(1.0, decision.ResolutionScale);
    }

    [Fact]
    public void A_pinned_profile_that_cannot_be_met_still_says_so()
    {
        RateController controller = Controller(adaptive: false);

        Assert.Equal("packet-loss", controller.Observe(Losing(30)).DegradedReason);
        Assert.Equal(
            "bandwidth",
            controller.Observe(Healthy(estimate: 500_000)).DegradedReason);
        Assert.Equal(
            "encoder-overloaded",
            controller.Observe(new RateSignals(null, 0, 20, 50, 60, 20)).DegradedReason);

        // Nothing is changed, but staying silent while the stream visibly struggles would
        // leave the operator blaming the wrong thing.
        Assert.Null(controller.Observe(Healthy()).DegradedReason);
    }

    /* --------------------------------------------------------------------- */
    /* Pinned levers                                                          */
    /* --------------------------------------------------------------------- */

    [Fact]
    public void A_pinned_bitrate_does_not_move_however_bad_the_link_gets()
    {
        RateController controller = Pinned(bitrate: 6_000_000);

        Assert.Equal(6_000_000, controller.BitrateBps);
        Assert.True(controller.HasPins);

        for (var interval = 0; interval < 10; interval++)
        {
            RateDecision decision = controller.Observe(Terrible());
            Assert.Equal(6_000_000, decision.BitrateBps);
            Assert.False(decision.BitrateChanged);
        }

        // Held, but not hidden. A stream sending six megabits down a link that will carry
        // four hundred kilobits is degraded, and the operator is the one who can undo it.
        Assert.Equal("packet-loss", controller.Observe(Terrible()).DegradedReason);
    }

    [Fact]
    public void A_pinned_bitrate_leaves_the_other_levers_free()
    {
        RateController controller = Pinned(bitrate: 6_000_000);

        // An encoder that cannot make its frame budget is not a bandwidth problem, and the
        // lever that fixes it is not the one the operator took away.
        RateDecision decision = controller.Observe(new RateSignals(null, 0, 20, 50, 60, 20));

        _output.WriteLine($"pinned bitrate, overloaded encoder: {decision.FrameRate} fps");

        Assert.Equal("encoder-overloaded", decision.DegradedReason);
        Assert.True(decision.FrameRateChanged);
        Assert.Equal(RateLimits.FrameRateLadder[1], decision.FrameRate);
        Assert.Equal(6_000_000, decision.BitrateBps);
    }

    [Fact]
    public void A_pinned_frame_rate_survives_an_encoder_that_cannot_keep_up()
    {
        RateController controller = Pinned(frameRate: 60);

        RateDecision decision = controller.Observe(new RateSignals(null, 0, 20, 50, 60, 20));

        // The operator asked for 60. They get 60, and they get told the machine is not
        // managing it — which is a different thing from being quietly given 30.
        Assert.Equal(60, decision.FrameRate);
        Assert.False(decision.FrameRateChanged);
        Assert.Equal("encoder-overloaded", decision.DegradedReason);
    }

    [Fact]
    public void A_pinned_frame_rate_is_used_as_typed_rather_than_snapped_to_the_ladder()
    {
        // The ladder exists to make automatic steps feel gradual. Somebody who typed 45
        // asked for 45, and rounding them to 48 or 30 would be answering a question they
        // did not ask.
        RateController controller = Pinned(frameRate: 45);

        Assert.Equal(45, controller.FrameRate);
        Assert.DoesNotContain(45, RateLimits.FrameRateLadder);
        Assert.Equal(45, controller.Observe(Terrible()).FrameRate);
    }

    [Fact]
    public void Resolution_still_comes_down_when_both_other_levers_are_pinned()
    {
        RateController controller = Pinned(bitrate: 6_000_000, frameRate: 60);

        RateDecision decision = controller.Observe(Terrible());

        _output.WriteLine($"both pinned: scale fell to {decision.ResolutionScale:P0}");

        // A pinned lever is exhausted by definition. Waiting for the bitrate to reach a
        // floor it will never reach would leave the one free lever doing nothing at all.
        Assert.True(decision.ResolutionChanged);
        Assert.Equal(RateLimits.ResolutionLadder[1], decision.ResolutionScale);
    }

    [Fact]
    public void A_pinned_resolution_is_never_scaled_away()
    {
        // Bad on both counts: a link that will not carry the stream and an encoder that
        // cannot make its budget. Resolution only comes down once both of the cheaper
        // levers have run out, so anything gentler would prove nothing.
        var hopeless = new RateSignals(400_000, 30, 200, EncodeMsPerFrame: 50, CapturedFps: 60, EncodedFps: 20);

        // A control run, so the test fails if it stops exercising the thing it names.
        RateController unpinned = Controller();
        for (var interval = 0; interval < 20; interval++) unpinned.Observe(hopeless);
        Assert.True(unpinned.ResolutionScale < 1.0, "an unpinned stream should have scaled down by now");

        RateController controller = Pinned(scale: 0.75);

        Assert.Equal(0.75, controller.ResolutionScale);

        for (var interval = 0; interval < 20; interval++)
        {
            RateDecision decision = controller.Observe(hopeless);
            Assert.Equal(0.75, decision.ResolutionScale);
            Assert.False(decision.ResolutionChanged);
        }

        // Everything else has bottomed out, so the stream is degraded and says why.
        RateDecision last = controller.Observe(hopeless);
        Assert.Equal(RateLimits.AbsoluteFloorBps, last.BitrateBps);
        Assert.Equal(RateLimits.FrameRateLadder[^1], last.FrameRate);
        Assert.NotNull(last.DegradedReason);
    }

    [Fact]
    public void Recovery_gives_nothing_back_to_a_pinned_lever()
    {
        RateController controller = Pinned(bitrate: 3_000_000, scale: 0.5);

        // Long enough for several recovery windows to come round.
        for (var interval = 0; interval < 30; interval++)
        {
            RateDecision decision = controller.Observe(Healthy());
            Assert.Equal(3_000_000, decision.BitrateBps);
            Assert.Equal(0.5, decision.ResolutionScale);
        }

        // Handing quality back to a lever the operator is holding is not generosity; it is
        // ignoring them slowly.
        Assert.Equal(3_000_000, controller.BitrateBps);
        Assert.Equal(0.5, controller.ResolutionScale);
        Assert.Null(controller.Observe(Healthy()).DegradedReason);
    }

    [Fact]
    public void A_pinned_bitrate_below_the_profile_floor_is_not_reported_as_a_shortfall()
    {
        // Min is 2 Mbps and the pin is under it. That is not the network failing to meet
        // the profile — it is the same person saying something more specific, so the pin
        // replaces the range rather than permanently disagreeing with it.
        RateController controller = Pinned(bitrate: 800_000);

        Assert.Equal(800_000, controller.BitrateBps);
        Assert.Null(controller.Observe(Healthy()).DegradedReason);
    }

    [Fact]
    public void An_unpinned_controller_says_it_has_no_pins()
    {
        Assert.False(Controller().HasPins);
        Assert.True(Pinned(frameRate: 30).HasPins);
    }
}
