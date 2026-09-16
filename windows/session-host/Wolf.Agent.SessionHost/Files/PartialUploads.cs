using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace Wolf.Agent.SessionHost.Files;

/// <summary>
/// Part files of uploads that were interrupted rather than stopped, kept a while so a new stream can finish them.
///
/// A data channel on somebody's home internet drops, and the stream that replaces it is a new stream with a new
/// file channel. Deleting the part file when the old one ended made every interrupted upload start again from
/// nothing. So an interruption — the stream ending, the lease lapsing — keeps the part file and records it here
/// with an expiry. Resuming claims it back; so do finishing and stopping. Whatever is still recorded when its time
/// is up is deleted, so half a file does not sit on somebody's disk indefinitely with nothing to finish it.
///
/// The record is a small file in the signed-in user's own local application data — the same user who can already
/// see the part files it names — so a session host that restarts still cleans up after the one before. It deletes
/// part files and nothing else, and no path is ever logged.
/// </summary>
public sealed class PartialUploads
{
    /// <summary>How long an interrupted upload waits to be resumed. Matches the protocol.</summary>
    public static readonly TimeSpan KeptFor = TimeSpan.FromMinutes(30);

    private static readonly TimeSpan SweepEvery = TimeSpan.FromMinutes(5);
    private static readonly object Shared = new();
    private static PartialUploads? _currentUser;
    private static Timer? _sweeper;

    private readonly string _registryPath;
    private readonly ILogger _logger;
    private readonly object _gate = new();

    public PartialUploads(string directory, ILogger logger)
    {
        _registryPath = Path.Combine(directory, "partial-uploads.json");
        _logger = logger;
    }

    /// <summary>
    /// The signed-in user's record, swept on a timer as well as whenever a stream starts: a PC nobody streams from
    /// for an afternoon still clears what it kept.
    /// </summary>
    public static PartialUploads ForCurrentUser(ILoggerFactory loggers)
    {
        lock (Shared)
        {
            if (_currentUser is null)
            {
                var created = new PartialUploads(
                    Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                        "WOLF",
                        "session-host"),
                    loggers.CreateLogger<PartialUploads>());
                _currentUser = created;
                _sweeper = new Timer(_ => created.Sweep(DateTimeOffset.UtcNow), null, SweepEvery, SweepEvery);
            }

            return _currentUser;
        }
    }

    /// <summary>An upload was interrupted: keep its part file until <see cref="KeptFor"/> from now.</summary>
    public void Keep(string partPath, DateTimeOffset now)
    {
        lock (_gate)
        {
            Dictionary<string, DateTimeOffset> records = Load();
            records[partPath] = now + KeptFor;
            Save(records);
        }
    }

    /// <summary>The part file is a transfer's again — resumed, finished, or stopped — and not the janitor's.</summary>
    public void Claim(string partPath)
    {
        lock (_gate)
        {
            Dictionary<string, DateTimeOffset> records = Load();
            if (records.Remove(partPath)) Save(records);
        }
    }

    /// <summary>Delete the part files whose time is up. Returns how many were removed.</summary>
    public int Sweep(DateTimeOffset now)
    {
        lock (_gate)
        {
            Dictionary<string, DateTimeOffset> records = Load();
            var due = records.Where(record => record.Value <= now).Select(record => record.Key).ToList();
            if (due.Count == 0) return 0;

            int removed = 0;
            foreach (string path in due)
            {
                records.Remove(path);

                // A part file, and nothing else, ever. A record that somehow named another file is not a reason
                // to delete that file.
                if (!path.EndsWith(FileChannel.PartSuffix, StringComparison.OrdinalIgnoreCase)) continue;

                try
                {
                    if (File.Exists(path))
                    {
                        File.Delete(path);
                        removed++;
                    }
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    // Left where it is. It names itself, and a transfer holding it open is not one to disturb.
                }
            }

            Save(records);
            if (removed > 0)
            {
                _logger.LogInformation("Removed {Count} unfinished upload part file(s) nobody resumed.", removed);
            }

            return removed;
        }
    }

    private Dictionary<string, DateTimeOffset> Load()
    {
        try
        {
            if (!File.Exists(_registryPath)) return new Dictionary<string, DateTimeOffset>(StringComparer.OrdinalIgnoreCase);
            Dictionary<string, DateTimeOffset>? loaded =
                JsonSerializer.Deserialize<Dictionary<string, DateTimeOffset>>(File.ReadAllText(_registryPath));
            return new Dictionary<string, DateTimeOffset>(
                loaded ?? new Dictionary<string, DateTimeOffset>(),
                StringComparer.OrdinalIgnoreCase);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            return new Dictionary<string, DateTimeOffset>(StringComparer.OrdinalIgnoreCase);
        }
    }

    private void Save(Dictionary<string, DateTimeOffset> records)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_registryPath)!);
            string temporary = _registryPath + ".tmp";
            File.WriteAllText(temporary, JsonSerializer.Serialize(records));
            File.Move(temporary, _registryPath, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // The part files are still where they are; what is lost is only the reminder to clear them.
            _logger.LogWarning("The record of unfinished uploads could not be saved ({Error}).", ex.GetType().Name);
        }
    }
}
