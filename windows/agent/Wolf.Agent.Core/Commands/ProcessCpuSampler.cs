namespace Wolf.Agent.Core.Commands;

/// <summary>
/// Per-process CPU usage, from two readings of how much CPU time each process has consumed.
///
/// Windows keeps a running total of CPU time per process, not a percentage. A percentage is the
/// difference between two totals divided by the wall time between them — so it cannot come from a
/// single look, and the first process list after a quiet spell costs a short wait for the second
/// reading. Reporting the lifetime average instead would be a number with the right units and the
/// wrong meaning: a browser that idled all day after a busy minute would look idle while pegging a
/// core right now.
///
/// Pure apart from what it remembers; the clock is passed in, so tests control it.
/// </summary>
public sealed class ProcessCpuSampler
{
    /// <summary>Readings closer together than this are too noisy to divide by.</summary>
    public static readonly TimeSpan MinimumInterval = TimeSpan.FromMilliseconds(250);

    /// <summary>A baseline older than this describes the past, not now.</summary>
    public static readonly TimeSpan MaximumAge = TimeSpan.FromSeconds(30);

    /// <param name="Pid">Process id.</param>
    /// <param name="StartTicks">
    /// When the process started. Part of its identity: Windows reuses PIDs quickly, and differencing
    /// a new process's CPU time against an exited one's would produce a nonsense rate.
    /// </param>
    /// <param name="CpuTime">Total CPU time consumed so far, across all cores.</param>
    public readonly record struct Observation(int Pid, long StartTicks, TimeSpan CpuTime);

    private readonly int _processorCount;
    private readonly object _gate = new();
    private Dictionary<int, Observation> _previous = new();
    private TimeSpan? _previousAt;

    public ProcessCpuSampler(int processorCount)
    {
        _processorCount = Math.Max(1, processorCount);
    }

    public bool HasFreshBaseline(TimeSpan now)
    {
        lock (_gate)
        {
            return _previousAt is TimeSpan at && now - at >= TimeSpan.Zero && now - at <= MaximumAge;
        }
    }

    /// <summary>
    /// Record a reading and return each process's CPU percentage since the previous one.
    ///
    /// Percent of the whole machine, as Task Manager shows it: a process pegging one core of eight
    /// is 12.5%. A process with no comparable earlier reading is absent from the result, and the
    /// caller reports it as null — never as zero.
    /// </summary>
    public IReadOnlyDictionary<int, double> Observe(IReadOnlyCollection<Observation> observations, TimeSpan now)
    {
        lock (_gate)
        {
            var percents = new Dictionary<int, double>();

            if (_previousAt is TimeSpan earlier)
            {
                TimeSpan elapsed = now - earlier;
                if (elapsed >= MinimumInterval && elapsed <= MaximumAge)
                {
                    double capacityMs = elapsed.TotalMilliseconds * _processorCount;

                    foreach (Observation observation in observations)
                    {
                        if (_previous.TryGetValue(observation.Pid, out Observation before) &&
                            before.StartTicks == observation.StartTicks &&
                            observation.CpuTime >= before.CpuTime)
                        {
                            double used = (observation.CpuTime - before.CpuTime).TotalMilliseconds;
                            percents[observation.Pid] = Math.Clamp(used / capacityMs * 100, 0, 100);
                        }
                    }
                }
            }

            var next = new Dictionary<int, Observation>(observations.Count);
            foreach (Observation observation in observations)
            {
                next[observation.Pid] = observation;
            }

            _previous = next;
            _previousAt = now;
            return percents;
        }
    }
}
