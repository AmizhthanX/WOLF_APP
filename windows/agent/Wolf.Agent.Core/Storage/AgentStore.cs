using System.Globalization;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging;
using Wolf.Agent.Core.Protocol;

namespace Wolf.Agent.Core.Storage;

/// <summary>A power action the agent has promised to perform at a specific instant.</summary>
public sealed record PendingPowerAction(
    string PendingActionId,
    string Action,
    DateTimeOffset RunAt,
    bool Force,
    string? RequestedBy,
    string? Reason);

/// <summary>
/// Local state that has to survive a restart or an outage.
///
/// This is what makes the agent useful without the cloud: telemetry keeps accumulating,
/// command results wait to be delivered, and scheduled power actions remember when they
/// are due. Nothing secret is stored here — the identity key lives in DPAPI-protected
/// storage, and command payloads never carry credentials.
/// </summary>
public sealed class AgentStore : IDisposable
{
    private readonly SqliteConnection _connection;
    private readonly ILogger<AgentStore> _logger;
    private readonly object _gate = new();

    public AgentStore(string databasePath, ILogger<AgentStore> logger)
    {
        _logger = logger;
        Directory.CreateDirectory(Path.GetDirectoryName(databasePath)!);

        _connection = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = databasePath,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Pooling = false,
        }.ToString());

        _connection.Open();
        Initialize();
    }

    private void Initialize()
    {
        Execute("""
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;

            CREATE TABLE IF NOT EXISTS settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            -- Samples buffered while the cloud is unreachable, replayed on reconnect.
            CREATE TABLE IF NOT EXISTS telemetry_queue (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                sampled_at TEXT NOT NULL,
                payload    TEXT NOT NULL
            );

            -- Results the agent produced but could not deliver. Retained so an action that
            -- really happened is never reported as merely "pending" forever.
            CREATE TABLE IF NOT EXISTS result_queue (
                command_id TEXT PRIMARY KEY,
                payload    TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            -- Completed command outcomes, keyed by command id, so a redelivered command
            -- returns its original result instead of running the action twice.
            CREATE TABLE IF NOT EXISTS completed_commands (
                command_id      TEXT PRIMARY KEY,
                idempotency_key TEXT NOT NULL,
                payload         TEXT NOT NULL,
                completed_at    TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS pending_power_actions (
                pending_action_id TEXT PRIMARY KEY,
                action            TEXT NOT NULL,
                run_at            TEXT NOT NULL,
                force             INTEGER NOT NULL,
                requested_by      TEXT,
                reason            TEXT
            );

            -- Local audit trail. Kept even when the cloud is unreachable, so an action taken
            -- during an outage is still accounted for afterwards.
            CREATE TABLE IF NOT EXISTS local_audit (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                occurred_at TEXT NOT NULL,
                action      TEXT NOT NULL,
                outcome     TEXT NOT NULL,
                detail      TEXT
            );
            """);
    }

    // -----------------------------------------------------------------------
    // Settings
    // -----------------------------------------------------------------------

    public string? GetSetting(string key)
    {
        lock (_gate)
        {
            using SqliteCommand command = _connection.CreateCommand();
            command.CommandText = "SELECT value FROM settings WHERE key = $key";
            command.Parameters.AddWithValue("$key", key);
            return command.ExecuteScalar() as string;
        }
    }

    public void SetSetting(string key, string value)
    {
        lock (_gate)
        {
            using SqliteCommand command = _connection.CreateCommand();
            command.CommandText = """
                INSERT INTO settings (key, value) VALUES ($key, $value)
                ON CONFLICT (key) DO UPDATE SET value = excluded.value
                """;
            command.Parameters.AddWithValue("$key", key);
            command.Parameters.AddWithValue("$value", value);
            command.ExecuteNonQuery();
        }
    }

    /// <summary>Local kill switch. Only a local operator can clear it; the cloud cannot.</summary>
    public bool KillSwitchEngaged
    {
        get => GetSetting("kill_switch") == "engaged";
        set => SetSetting("kill_switch", value ? "engaged" : "released");
    }

    // -----------------------------------------------------------------------
    // Telemetry buffer
    // -----------------------------------------------------------------------

    public void EnqueueTelemetry(string sampledAt, string payloadJson, int limit)
    {
        lock (_gate)
        {
            using SqliteCommand insert = _connection.CreateCommand();
            insert.CommandText =
                "INSERT INTO telemetry_queue (sampled_at, payload) VALUES ($sampledAt, $payload)";
            insert.Parameters.AddWithValue("$sampledAt", sampledAt);
            insert.Parameters.AddWithValue("$payload", payloadJson);
            insert.ExecuteNonQuery();

            // Bound the buffer: an agent that is offline for a week must not fill the disk.
            // The oldest samples are dropped first, because recent history is what an
            // operator actually looks at after an outage.
            using SqliteCommand trim = _connection.CreateCommand();
            trim.CommandText = """
                DELETE FROM telemetry_queue
                 WHERE id NOT IN (SELECT id FROM telemetry_queue ORDER BY id DESC LIMIT $limit)
                """;
            trim.Parameters.AddWithValue("$limit", limit);
            trim.ExecuteNonQuery();
        }
    }

    public IReadOnlyList<(long Id, string Payload)> PeekTelemetry(int count)
    {
        lock (_gate)
        {
            var results = new List<(long, string)>();
            using SqliteCommand command = _connection.CreateCommand();
            command.CommandText = "SELECT id, payload FROM telemetry_queue ORDER BY id LIMIT $count";
            command.Parameters.AddWithValue("$count", count);

            using SqliteDataReader reader = command.ExecuteReader();
            while (reader.Read())
            {
                results.Add((reader.GetInt64(0), reader.GetString(1)));
            }

            return results;
        }
    }

    public void DeleteTelemetry(IEnumerable<long> ids)
    {
        lock (_gate)
        {
            using SqliteTransaction transaction = _connection.BeginTransaction();
            foreach (long id in ids)
            {
                using SqliteCommand command = _connection.CreateCommand();
                command.Transaction = transaction;
                command.CommandText = "DELETE FROM telemetry_queue WHERE id = $id";
                command.Parameters.AddWithValue("$id", id);
                command.ExecuteNonQuery();
            }

            transaction.Commit();
        }
    }

    public int TelemetryQueueDepth()
    {
        lock (_gate)
        {
            using SqliteCommand command = _connection.CreateCommand();
            command.CommandText = "SELECT count(*) FROM telemetry_queue";
            return Convert.ToInt32(command.ExecuteScalar(), CultureInfo.InvariantCulture);
        }
    }

    // -----------------------------------------------------------------------
    // Command results
    // -----------------------------------------------------------------------

    public void RecordCompletedCommand(string commandId, string idempotencyKey, CommandResultPayload payload)
    {
        string json = JsonSerializer.Serialize(payload, WolfProtocol.Json);
        lock (_gate)
        {
            using SqliteCommand command = _connection.CreateCommand();
            command.CommandText = """
                INSERT INTO completed_commands (command_id, idempotency_key, payload, completed_at)
                VALUES ($id, $key, $payload, $at)
                ON CONFLICT (command_id) DO NOTHING
                """;
            command.Parameters.AddWithValue("$id", commandId);
            command.Parameters.AddWithValue("$key", idempotencyKey);
            command.Parameters.AddWithValue("$payload", json);
            command.Parameters.AddWithValue("$at", DateTimeOffset.UtcNow.ToString("o"));
            command.ExecuteNonQuery();
        }
    }

    public bool TryGetCompletedCommand(string commandId, out CommandResultPayload? payload)
    {
        lock (_gate)
        {
            using SqliteCommand command = _connection.CreateCommand();
            command.CommandText = "SELECT payload FROM completed_commands WHERE command_id = $id";
            command.Parameters.AddWithValue("$id", commandId);

            if (command.ExecuteScalar() is not string json)
            {
                payload = null;
                return false;
            }

            payload = JsonSerializer.Deserialize<CommandResultPayload>(json, WolfProtocol.Json);
            return payload is not null;
        }
    }

    public void EnqueueResult(CommandResultPayload payload)
    {
        string json = JsonSerializer.Serialize(payload, WolfProtocol.Json);
        lock (_gate)
        {
            using SqliteCommand command = _connection.CreateCommand();
            command.CommandText = """
                INSERT INTO result_queue (command_id, payload, created_at)
                VALUES ($id, $payload, $at)
                ON CONFLICT (command_id) DO UPDATE SET payload = excluded.payload
                """;
            command.Parameters.AddWithValue("$id", payload.CommandId);
            command.Parameters.AddWithValue("$payload", json);
            command.Parameters.AddWithValue("$at", DateTimeOffset.UtcNow.ToString("o"));
            command.ExecuteNonQuery();
        }
    }

    public IReadOnlyList<CommandResultPayload> PendingResults()
    {
        lock (_gate)
        {
            var results = new List<CommandResultPayload>();
            using SqliteCommand command = _connection.CreateCommand();
            command.CommandText = "SELECT payload FROM result_queue ORDER BY created_at";

            using SqliteDataReader reader = command.ExecuteReader();
            while (reader.Read())
            {
                CommandResultPayload? payload =
                    JsonSerializer.Deserialize<CommandResultPayload>(reader.GetString(0), WolfProtocol.Json);
                if (payload is not null)
                {
                    results.Add(payload);
                }
            }

            return results;
        }
    }

    public void DeleteResult(string commandId)
    {
        lock (_gate)
        {
            using SqliteCommand command = _connection.CreateCommand();
            command.CommandText = "DELETE FROM result_queue WHERE command_id = $id";
            command.Parameters.AddWithValue("$id", commandId);
            command.ExecuteNonQuery();
        }
    }

    // -----------------------------------------------------------------------
    // Scheduled power actions
    // -----------------------------------------------------------------------

    public void SavePendingPowerAction(PendingPowerAction action)
    {
        lock (_gate)
        {
            using SqliteCommand command = _connection.CreateCommand();
            command.CommandText = """
                INSERT INTO pending_power_actions
                    (pending_action_id, action, run_at, force, requested_by, reason)
                VALUES ($id, $action, $runAt, $force, $by, $reason)
                ON CONFLICT (pending_action_id) DO UPDATE SET
                    action = excluded.action,
                    run_at = excluded.run_at,
                    force = excluded.force
                """;
            command.Parameters.AddWithValue("$id", action.PendingActionId);
            command.Parameters.AddWithValue("$action", action.Action);
            command.Parameters.AddWithValue("$runAt", action.RunAt.ToString("o"));
            command.Parameters.AddWithValue("$force", action.Force ? 1 : 0);
            command.Parameters.AddWithValue("$by", (object?)action.RequestedBy ?? DBNull.Value);
            command.Parameters.AddWithValue("$reason", (object?)action.Reason ?? DBNull.Value);
            command.ExecuteNonQuery();
        }
    }

    public IReadOnlyList<PendingPowerAction> PendingPowerActions()
    {
        lock (_gate)
        {
            var actions = new List<PendingPowerAction>();
            using SqliteCommand command = _connection.CreateCommand();
            command.CommandText = """
                SELECT pending_action_id, action, run_at, force, requested_by, reason
                  FROM pending_power_actions ORDER BY run_at
                """;

            using SqliteDataReader reader = command.ExecuteReader();
            while (reader.Read())
            {
                actions.Add(new PendingPowerAction(
                    reader.GetString(0),
                    reader.GetString(1),
                    DateTimeOffset.Parse(reader.GetString(2), CultureInfo.InvariantCulture),
                    reader.GetInt32(3) != 0,
                    reader.IsDBNull(4) ? null : reader.GetString(4),
                    reader.IsDBNull(5) ? null : reader.GetString(5)));
            }

            return actions;
        }
    }

    public bool DeletePendingPowerAction(string pendingActionId)
    {
        lock (_gate)
        {
            using SqliteCommand command = _connection.CreateCommand();
            command.CommandText = "DELETE FROM pending_power_actions WHERE pending_action_id = $id";
            command.Parameters.AddWithValue("$id", pendingActionId);
            return command.ExecuteNonQuery() > 0;
        }
    }

    // -----------------------------------------------------------------------
    // Local audit
    // -----------------------------------------------------------------------

    public void RecordLocalAudit(string action, string outcome, object? detail = null)
    {
        lock (_gate)
        {
            using SqliteCommand command = _connection.CreateCommand();
            command.CommandText = """
                INSERT INTO local_audit (occurred_at, action, outcome, detail)
                VALUES ($at, $action, $outcome, $detail)
                """;
            command.Parameters.AddWithValue("$at", DateTimeOffset.UtcNow.ToString("o"));
            command.Parameters.AddWithValue("$action", action);
            command.Parameters.AddWithValue("$outcome", outcome);
            command.Parameters.AddWithValue(
                "$detail",
                detail is null ? DBNull.Value : JsonSerializer.Serialize(detail, WolfProtocol.Json));
            command.ExecuteNonQuery();
        }
    }

    private void Execute(string sql)
    {
        using SqliteCommand command = _connection.CreateCommand();
        command.CommandText = sql;
        command.ExecuteNonQuery();
    }

    public void Dispose()
    {
        _connection.Dispose();
        _logger.LogDebug("Closed the local WOLF store.");
    }
}
