using Wolf.Agent.SessionHost.Capture;

namespace Wolf.Agent.SessionHost.Adaptation;

/// <summary>What the stream is allowed to do, from the profile the operator chose.</summary>
public sealed record RateLimits(
    int MinBitrateBps,
    int MaxBitrateBps,
    int TargetFrameRate,
    /// <summary>False when the operator pinned the profile; the controller then does nothing.</summary>
    bool Adaptive = true)
{
    /// <summary>
    /// The lowest bitrate worth sending, whatever the profile says.
    ///
    /// Below this a 1440p stream is not a picture, it is a rumour. When the link cannot
    /// carry even this, the answer is to report a degraded stream rather than to keep
    /// halving until there is nothing left.
    /// </summary>
    public const int AbsoluteFloorBps = 200_000;

    /// <summary>Frame rates to step down through. Halving would be too coarse to feel gradual.</summary>
    public static readonly int[] FrameRateLadder = { 60, 48, 30, 24, 15 };

    /// <summary>
    /// Fractions of the full resolution to step down through.
    ///
    /// Stops at half. Below that the text on a remote desktop stops being readable, and an
    /// unreadable desktop is not a degraded stream — it is a useless one. When halving is
    /// not enough, the honest answer is a degraded stream at half size rather than a
    /// thumbnail nobody can work in.
    /// </summary>
    public static readonly double[] ResolutionLadder = { 1.0, 0.75, 0.5 };
}

/// <summary>Everything the controller gets to reason from, this interval.</summary>
public sealed record RateSignals(
    /// <summary>Congestion control's estimate of what the path will carry, or null if none yet.</summary>
    int? EstimatedBitrateBps,
    /// <summary>Loss the receiver reported, 0..100, or null when nothing has been reported.</summary>
    double? PacketLossPercent,
    double? RoundTripMs,
    /// <summary>Milliseconds the encoder spends per frame.</summary>
    double EncodeMsPerFrame,
    double CapturedFps,
    double EncodedFps);

/// <summary>What to do about it.</summary>
public sealed record RateDecision(
    int BitrateBps,
    int FrameRate,
    /// <summary>Fraction of the full resolution to encode, 1.0 for all of it.</summary>
    double ResolutionScale,
    /// <summary>Null when the stream is running at the profile it was asked for.</summary>
    string? DegradedReason,
    bool BitrateChanged,
    bool FrameRateChanged,
    bool ResolutionChanged);

/// <summary>
/// Decides what the stream should cost, from what the link and the machine are doing.
///
/// Separated from everything that has a side effect so the policy can be tested against
/// sequences of conditions rather than inferred from a running stream. Adaptation that only
/// gets exercised on a congested network is adaptation nobody has checked.
///
/// The order of concessions is deliberate and is the PRD's: **bitrate first, then frame
/// rate, and resolution last**. A bitrate change is invisible. A frame rate change is
/// noticeable but harmless. A resolution change costs a key frame and re-lays out
/// everything the operator is looking at, so it is the last thing to reach for — and it is
/// not implemented in this build at all, which the stream reports rather than pretending.
///
/// Coming back up is slower than going down, on purpose. Congestion recovers in steps and
/// probing too eagerly produces a stream that oscillates between good and unwatchable,
/// which is worse to use than one that settles slightly low.
/// </summary>
public sealed class RateController
{
    /// <summary>Loss above which the link is clearly in trouble and a big cut is warranted.</summary>
    private const double SevereLossPercent = 10;

    /// <summary>Loss above which something is wrong, but gently.</summary>
    private const double MildLossPercent = 2;

    /// <summary>Loss below which the path is considered healthy enough to probe upward.</summary>
    private const double HealthyLossPercent = 0.5;

    private const double SevereCut = 0.6;
    private const double MildCut = 0.85;

    /// <summary>Additive increase per healthy interval. Slow on purpose.</summary>
    private const double Probe = 1.08;

    /// <summary>Headroom left under the estimate, so the stream is not riding the ceiling.</summary>
    private const double EstimateHeadroom = 0.95;

    /// <summary>
    /// Share of the frame budget the encoder may use before the frame rate comes down.
    ///
    /// Not 1.0: an encoder that takes the whole interval has no margin for a complex frame,
    /// and the queue grows until latency is measured in seconds.
    /// </summary>
    private const double EncodeBudgetShare = 0.8;

    /// <summary>Consecutive healthy intervals before anything is given back.</summary>
    private const int IntervalsBeforeRecovery = 3;

    private readonly RateLimits _limits;

    private int _bitrate;
    private int _frameRateIndex;
    private int _resolutionIndex;
    private int _healthyIntervals;

    public RateController(RateLimits limits)
    {
        _limits = limits;
        _bitrate = limits.MaxBitrateBps;
        _frameRateIndex = NearestLadderIndex(limits.TargetFrameRate);
    }

    public int BitrateBps => _bitrate;

    public int FrameRate => Math.Min(_limits.TargetFrameRate, RateLimits.FrameRateLadder[_frameRateIndex]);

    /// <summary>Fraction of the full resolution currently being encoded.</summary>
    public double ResolutionScale => RateLimits.ResolutionLadder[_resolutionIndex];

    /// <summary>
    /// Take one interval's worth of signals and decide.
    ///
    /// Returns what the stream should now be running at, whether either value changed, and —
    /// when it is running below what was asked for — which of the protocol's degraded
    /// reasons applies. The reason is not cosmetic: "your network" and "this PC" call for
    /// different responses from the person watching.
    /// </summary>
    public RateDecision Observe(RateSignals signals)
    {
        int previousBitrate = _bitrate;
        int previousFrameRate = FrameRate;
        double previousScale = ResolutionScale;

        if (!_limits.Adaptive)
        {
            // The operator pinned the profile. Honour it, and say so if the machine cannot
            // keep up rather than quietly overriding the choice.
            return new RateDecision(
                _bitrate,
                FrameRate,
                ResolutionScale,
                DescribePinnedShortfall(signals),
                false,
                false,
                false);
        }

        string? reason = null;
        bool healthy = true;

        // 1. Loss first. It is the signal that something is already being thrown away, and
        //    no amount of estimate optimism outranks packets that did not arrive.
        if (signals.PacketLossPercent is { } loss && loss >= MildLossPercent)
        {
            double factor = loss >= SevereLossPercent ? SevereCut : MildCut;
            _bitrate = (int)(_bitrate * factor);
            reason = "packet-loss";
            healthy = false;
        }

        // 2. The congestion estimate. Only ever used to come down here; coming up is the
        //    slow probe below, because an estimate that briefly spikes is not a promise.
        if (signals.EstimatedBitrateBps is { } estimate && estimate > 0)
        {
            int ceiling = (int)(estimate * EstimateHeadroom);
            if (ceiling < _bitrate)
            {
                _bitrate = ceiling;
                reason ??= "bandwidth";
                healthy = false;
            }
        }

        // 3. The encoder. If it cannot produce frames inside the interval it is given, no
        //    bitrate will help — the frame rate has to come down.
        double budgetMs = 1000.0 / Math.Max(1, FrameRate);
        if (signals.EncodeMsPerFrame > budgetMs * EncodeBudgetShare)
        {
            if (StepFrameRateDown()) reason = "encoder-overloaded";
            else reason ??= "encoder-overloaded";
            healthy = false;
        }

        // 4. Capture falling behind is neither the link's fault nor the encoder's, and
        //    neither lever fixes it. It is reported so nobody goes looking in the wrong place.
        else if (signals.CapturedFps > 0 && signals.CapturedFps < FrameRate * 0.7)
        {
            reason ??= "capture-slow";
        }

        // 5. Resolution, and only once the other two have run out. It is the most expensive
        //    change — a new encoder, a key frame, and a visible re-layout of everything the
        //    operator is looking at — so it is what is left when lowering the bitrate has
        //    reached the floor and the frame rate has reached the bottom of its ladder.
        if (!healthy &&
            _bitrate <= RateLimits.AbsoluteFloorBps &&
            _frameRateIndex >= RateLimits.FrameRateLadder.Length - 1 &&
            _resolutionIndex < RateLimits.ResolutionLadder.Length - 1)
        {
            _resolutionIndex++;
            reason ??= "bandwidth";
        }

        // 6. Recovery, once several intervals in a row have been clean.
        if (healthy && signals.PacketLossPercent is null or <= HealthyLossPercent)
        {
            _healthyIntervals++;

            if (_healthyIntervals >= IntervalsBeforeRecovery)
            {
                _healthyIntervals = 0;

                if (_bitrate < _limits.MaxBitrateBps)
                {
                    // Probe upward, but never past what the estimate says the path holds.
                    int probed = (int)(_bitrate * Probe);
                    if (signals.EstimatedBitrateBps is { } headroom && headroom > 0)
                    {
                        probed = Math.Min(probed, (int)(headroom * EstimateHeadroom));
                    }

                    _bitrate = Math.Max(_bitrate, probed);
                }
                else if (_resolutionIndex > 0)
                {
                    // Bitrate is back at the ceiling, so resolution comes next. Ahead of
                    // frame rate because a remote desktop is mostly read: text that is too
                    // soft to make out cannot be worked around, while a slower refresh can.
                    _resolutionIndex--;
                }
                else
                {
                    // Full size and full bitrate; smoothness is what is still owed.
                    StepFrameRateUp();
                }
            }
        }
        else
        {
            _healthyIntervals = 0;
        }

        _bitrate = Math.Clamp(_bitrate, RateLimits.AbsoluteFloorBps, _limits.MaxBitrateBps);

        // Running under the operator's floor is not a failure to report as bandwidth alone:
        // it means the profile they chose is not currently possible.
        if (_bitrate < _limits.MinBitrateBps) reason ??= "bandwidth";

        return new RateDecision(
            _bitrate,
            FrameRate,
            ResolutionScale,
            reason,
            _bitrate != previousBitrate,
            FrameRate != previousFrameRate,
            Math.Abs(ResolutionScale - previousScale) > double.Epsilon);
    }

    /// <summary>
    /// Why a pinned profile is not being met, if it is not.
    ///
    /// Nothing is changed in this case — the operator asked for these numbers — but staying
    /// silent while the stream visibly struggles would leave them blaming the wrong thing.
    /// </summary>
    private string? DescribePinnedShortfall(RateSignals signals)
    {
        if (signals.PacketLossPercent is { } loss && loss >= MildLossPercent) return "packet-loss";

        double budgetMs = 1000.0 / Math.Max(1, FrameRate);
        if (signals.EncodeMsPerFrame > budgetMs) return "encoder-overloaded";

        if (signals.EstimatedBitrateBps is { } estimate && estimate > 0 && estimate < _bitrate)
        {
            return "bandwidth";
        }

        return null;
    }

    private bool StepFrameRateDown()
    {
        if (_frameRateIndex >= RateLimits.FrameRateLadder.Length - 1) return false;
        _frameRateIndex++;
        return true;
    }

    private void StepFrameRateUp()
    {
        if (_frameRateIndex > NearestLadderIndex(_limits.TargetFrameRate)) _frameRateIndex--;
    }

    private static int NearestLadderIndex(int frameRate)
    {
        for (int index = 0; index < RateLimits.FrameRateLadder.Length; index++)
        {
            if (RateLimits.FrameRateLadder[index] <= frameRate) return index;
        }

        return RateLimits.FrameRateLadder.Length - 1;
    }

    /// <summary>Signals for one interval, assembled from the pipeline and the transport.</summary>
    public static RateSignals SignalsFrom(
        PipelineStats stats,
        int? estimatedBitrateBps,
        double? packetLossPercent,
        double? roundTripMs) =>
        new(
            estimatedBitrateBps,
            packetLossPercent,
            roundTripMs,
            stats.MeanEncodeMs,
            stats.CapturedFps,
            stats.EncodedFps);
}
