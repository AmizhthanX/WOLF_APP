namespace Wolf.Agent.Core;

/// <summary>
/// Agent configuration. Everything here is operational; no secrets live in configuration
/// files. The PC identity key is held in DPAPI-protected storage and the enrollment token
/// is supplied once, by the installer, and never written to disk.
/// </summary>
public sealed class AgentOptions
{
    public const string SectionName = "Wolf";

    /// <summary>HTTPS base address of the WOLF API, e.g. https://api.amizhthan.app.</summary>
    public string ApiBaseUrl { get; set; } = "https://api.amizhthan.app";

    /// <summary>WebSocket address of the realtime service, e.g. wss://relay.amizhthan.app/agent.</summary>
    public string RealtimeUrl { get; set; } = "wss://relay.amizhthan.app/agent";

    /// <summary>Directory holding the local database and protected identity material.</summary>
    public string DataDirectory { get; set; } =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "WOLF");

    /// <summary>Friendly name shown in the dashboard. Defaults to the machine name.</summary>
    public string? PcName { get; set; }

    /// <summary>Seconds between telemetry samples while a dashboard is watching.</summary>
    public int TelemetryIntervalSeconds { get; set; } = 5;

    /// <summary>Seconds between telemetry uploads. Samples are batched between uploads.</summary>
    public int TelemetryUploadSeconds { get; set; } = 15;

    /// <summary>Seconds between heartbeats. The cloud marks a PC offline after ~3 missed.</summary>
    public int HeartbeatSeconds { get; set; } = 30;

    /// <summary>Maximum samples buffered locally while the cloud is unreachable.</summary>
    public int OfflineSampleBufferLimit { get; set; } = 20_000;

    /// <summary>Initial reconnect delay; doubles up to <see cref="ReconnectMaxDelaySeconds"/>.</summary>
    public int ReconnectBaseDelaySeconds { get; set; } = 2;

    public int ReconnectMaxDelaySeconds { get; set; } = 300;

    public string DatabasePath => Path.Combine(DataDirectory, "wolf-agent.db");

    public string IdentityPath => Path.Combine(DataDirectory, "identity.bin");
}
