using System.Text.Json.Serialization;

namespace Wolf.Agent.Core.Telemetry;

/// <summary>
/// Telemetry payloads, mirroring <c>@wolf/telemetry-schema</c>.
///
/// Every numeric field is nullable on purpose. "This counter is not readable on this
/// machine" is a real answer — a desktop with no battery, a GPU with no driver-exposed
/// sensor, a disk with no SMART data — and reporting null keeps that distinguishable from
/// a genuine zero.
/// </summary>
public sealed record CpuSample(
    [property: JsonPropertyName("usagePercent")] double? UsagePercent,
    [property: JsonPropertyName("perCorePercent")] IReadOnlyList<double> PerCorePercent,
    [property: JsonPropertyName("frequencyMhz")] double? FrequencyMhz,
    [property: JsonPropertyName("temperatureCelsius")] double? TemperatureCelsius,
    [property: JsonPropertyName("queueLength")] double? QueueLength,
    [property: JsonPropertyName("packagePowerWatts")] double? PackagePowerWatts);

public sealed record MemorySample(
    [property: JsonPropertyName("totalBytes")] long? TotalBytes,
    [property: JsonPropertyName("usedBytes")] long? UsedBytes,
    [property: JsonPropertyName("availableBytes")] long? AvailableBytes,
    [property: JsonPropertyName("committedBytes")] long? CommittedBytes,
    [property: JsonPropertyName("commitLimitBytes")] long? CommitLimitBytes,
    [property: JsonPropertyName("cachedBytes")] long? CachedBytes);

public sealed record GpuSample(
    [property: JsonPropertyName("adapterId")] string AdapterId,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("usagePercent")] double? UsagePercent,
    [property: JsonPropertyName("graphicsEnginePercent")] double? GraphicsEnginePercent,
    [property: JsonPropertyName("computeEnginePercent")] double? ComputeEnginePercent,
    [property: JsonPropertyName("videoEncodeEnginePercent")] double? VideoEncodeEnginePercent,
    [property: JsonPropertyName("videoDecodeEnginePercent")] double? VideoDecodeEnginePercent,
    [property: JsonPropertyName("vramTotalBytes")] long? VramTotalBytes,
    [property: JsonPropertyName("vramUsedBytes")] long? VramUsedBytes,
    [property: JsonPropertyName("temperatureCelsius")] double? TemperatureCelsius,
    [property: JsonPropertyName("coreClockMhz")] double? CoreClockMhz,
    [property: JsonPropertyName("memoryClockMhz")] double? MemoryClockMhz,
    [property: JsonPropertyName("fanPercent")] double? FanPercent,
    [property: JsonPropertyName("powerWatts")] double? PowerWatts);

public sealed record DiskSample(
    [property: JsonPropertyName("volume")] string Volume,
    [property: JsonPropertyName("label")] string? Label,
    [property: JsonPropertyName("totalBytes")] long? TotalBytes,
    [property: JsonPropertyName("freeBytes")] long? FreeBytes,
    [property: JsonPropertyName("readBytesPerSecond")] double? ReadBytesPerSecond,
    [property: JsonPropertyName("writeBytesPerSecond")] double? WriteBytesPerSecond,
    [property: JsonPropertyName("activeTimePercent")] double? ActiveTimePercent,
    [property: JsonPropertyName("queueLength")] double? QueueLength,
    [property: JsonPropertyName("temperatureCelsius")] double? TemperatureCelsius,
    [property: JsonPropertyName("healthStatus")] string HealthStatus);

public sealed record NetworkSample(
    [property: JsonPropertyName("adapterId")] string AdapterId,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("kind")] string Kind,
    [property: JsonPropertyName("up")] bool Up,
    [property: JsonPropertyName("receiveBytesPerSecond")] double? ReceiveBytesPerSecond,
    [property: JsonPropertyName("sendBytesPerSecond")] double? SendBytesPerSecond,
    [property: JsonPropertyName("linkSpeedBitsPerSecond")] long? LinkSpeedBitsPerSecond,
    [property: JsonPropertyName("signalPercent")] double? SignalPercent);

public sealed record ThermalSample(
    [property: JsonPropertyName("sensor")] string Sensor,
    [property: JsonPropertyName("temperatureCelsius")] double? TemperatureCelsius);

public sealed record BatterySample(
    [property: JsonPropertyName("present")] bool Present,
    [property: JsonPropertyName("chargePercent")] double? ChargePercent,
    [property: JsonPropertyName("charging")] bool? Charging,
    [property: JsonPropertyName("runtimeSecondsRemaining")] double? RuntimeSecondsRemaining,
    [property: JsonPropertyName("healthPercent")] double? HealthPercent);

/// <summary>WOLF's own resource cost, so the agent can be held to its own budget.</summary>
public sealed record AgentSelfSample(
    [property: JsonPropertyName("cpuPercent")] double? CpuPercent,
    [property: JsonPropertyName("memoryBytes")] long? MemoryBytes,
    [property: JsonPropertyName("networkBytesPerSecond")] double? NetworkBytesPerSecond,
    [property: JsonPropertyName("captureActive")] bool CaptureActive,
    [property: JsonPropertyName("encoderActive")] bool EncoderActive);

public sealed record TelemetrySample(
    [property: JsonPropertyName("sampledAt")] string SampledAt,
    [property: JsonPropertyName("uptimeSeconds")] double? UptimeSeconds,
    [property: JsonPropertyName("cpu")] CpuSample Cpu,
    [property: JsonPropertyName("memory")] MemorySample Memory,
    [property: JsonPropertyName("gpus")] IReadOnlyList<GpuSample> Gpus,
    [property: JsonPropertyName("disks")] IReadOnlyList<DiskSample> Disks,
    [property: JsonPropertyName("networks")] IReadOnlyList<NetworkSample> Networks,
    [property: JsonPropertyName("thermal")] IReadOnlyList<ThermalSample> Thermal,
    [property: JsonPropertyName("battery")] BatterySample? Battery,
    [property: JsonPropertyName("agent")] AgentSelfSample? Agent);
