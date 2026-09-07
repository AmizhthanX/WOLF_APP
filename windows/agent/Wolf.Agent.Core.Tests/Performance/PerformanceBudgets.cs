namespace Wolf.Agent.Core.Tests.Performance;

/// <summary>
/// What "fast enough" means, in one place.
///
/// **These numbers are derived, not transcribed.** The PRD's test matrix is not recorded
/// anywhere in this repository, so each budget below comes from what the architecture
/// already commits to — the frame budget the adaptation controller works against, the
/// bitrate ceilings in the built-in profiles, the resolution ladder — or from what a person
/// can perceive. When the matrix is to hand, this is the file to correct; nothing else needs
/// to change.
///
/// Every budget is deliberately looser than the development machine measures. A performance
/// test that passes only on the machine it was written on is a test that will be deleted the
/// first time somebody runs it on a laptop, and the point of these is to catch a change that
/// makes the product *worse* — not to certify one particular GPU.
/// </summary>
internal static class PerformanceBudgets
{
    /// <summary>
    /// Encode time for one frame at 60 fps, as a share of the interval.
    ///
    /// The adaptation controller lowers the frame rate when encoding takes more than 80% of
    /// the interval, so anything at or above that is a stream that will be visibly degrading
    /// itself. Half the interval is the point at which there is no headroom left for a
    /// complex frame.
    /// </summary>
    public const double MeanEncodeMsAt60Fps = 8.0;

    /// <summary>
    /// The slowest frame in a hundred.
    ///
    /// Means hide stutter. A stream that encodes in half a millisecond and then takes 40 ms
    /// once a second feels broken while its average looks excellent, so the tail is what is
    /// actually budgeted.
    /// </summary>
    public const double P99EncodeMsAt60Fps = 16.0;

    /// <summary>
    /// Frames the pipeline should deliver against a 60 fps target, on a busy screen.
    ///
    /// Not 60: Windows Graphics Capture delivers a frame when the screen changes, so the
    /// achievable rate depends on what is on it. This is a floor for "the pipeline is
    /// keeping up", not a claim about the display.
    /// </summary>
    public const double MinimumSustainedFps = 20.0;

    /// <summary>
    /// From asking for a stream to the first picture arriving at the client.
    ///
    /// Covers negotiation, ICE, the DTLS handshake, building the capture pipeline, and the
    /// first key frame. Two seconds is the point at which somebody wonders whether they
    /// clicked the button.
    /// </summary>
    public const double TimeToFirstFrameMs = 2000;

    /// <summary>
    /// How long a resolution change may leave the client without a picture.
    ///
    /// A new converter, a new encoder, and a key frame. Adaptation reaches for this when a
    /// link is already struggling, so a change that costs a visible stall would make things
    /// worse at exactly the wrong moment.
    /// </summary>
    public const double ResolutionChangeGapMs = 500;

    /// <summary>
    /// How much a stream may exceed the bitrate its profile asked for.
    ///
    /// Rate control is a target, not a limit, and a key frame is far larger than the average
    /// frame — so some overshoot is expected. Twice the ceiling is not.
    /// </summary>
    public const double BitrateOvershoot = 2.0;

    /// <summary>
    /// Input batches the host must handle per second.
    ///
    /// A client sends a batch per frame, so 60 a second is the working rate and this is a
    /// wide margin over it. Input that queues behind its own validation would feel like lag
    /// the network gets blamed for.
    /// </summary>
    public const int MinimumInputBatchesPerSecond = 500;
}
