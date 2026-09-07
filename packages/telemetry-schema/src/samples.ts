import { z } from 'zod';
import { isoDateTime } from '@wolf/validation';

/**
 * Telemetry sample schemas.
 *
 * Every numeric field is nullable, because "the agent could not read this counter" is a
 * real and common answer on Windows — a GPU without a driver-exposed temperature sensor, a
 * desktop without a battery, a disk without SMART. WOLF reports the gap rather than
 * substituting a zero that would look like a healthy reading.
 */

const percent = z.number().min(0).max(100).nullable();
const bytes = z.number().nonnegative().nullable();
const celsius = z.number().min(-50).max(150).nullable();
const megahertz = z.number().nonnegative().nullable();

export const cpuSample = z.object({
  usagePercent: percent,
  /** Per-logical-processor usage; empty when per-core sampling is disabled. */
  perCorePercent: z.array(z.number().min(0).max(100)).max(256).default([]),
  frequencyMhz: megahertz,
  temperatureCelsius: celsius,
  /** Windows processor queue length, a better sustained-load signal than usage alone. */
  queueLength: z.number().nonnegative().nullable(),
  packagePowerWatts: z.number().nonnegative().nullable(),
});
export type CpuSample = z.infer<typeof cpuSample>;

export const memorySample = z.object({
  totalBytes: bytes,
  usedBytes: bytes,
  availableBytes: bytes,
  committedBytes: bytes,
  commitLimitBytes: bytes,
  cachedBytes: bytes,
});
export type MemorySample = z.infer<typeof memorySample>;

export const gpuSample = z.object({
  /** Stable adapter identifier (LUID or PCI path) so multi-GPU systems stay distinguishable. */
  adapterId: z.string().max(128),
  name: z.string().max(200),
  usagePercent: percent,
  /** Windows exposes GPU work per engine; these are the engines WOLF surfaces. */
  graphicsEnginePercent: percent,
  computeEnginePercent: percent,
  videoEncodeEnginePercent: percent,
  videoDecodeEnginePercent: percent,
  vramTotalBytes: bytes,
  vramUsedBytes: bytes,
  temperatureCelsius: celsius,
  coreClockMhz: megahertz,
  memoryClockMhz: megahertz,
  fanPercent: percent,
  powerWatts: z.number().nonnegative().nullable(),
});
export type GpuSample = z.infer<typeof gpuSample>;

export const diskSample = z.object({
  /** Drive letter or volume GUID path. */
  volume: z.string().max(128),
  label: z.string().max(200).nullable(),
  totalBytes: bytes,
  freeBytes: bytes,
  readBytesPerSecond: bytes,
  writeBytesPerSecond: bytes,
  activeTimePercent: percent,
  queueLength: z.number().nonnegative().nullable(),
  temperatureCelsius: celsius,
  /** SMART overall status where the drive and driver expose it. */
  healthStatus: z.enum(['healthy', 'warning', 'failing', 'unknown']).default('unknown'),
});
export type DiskSample = z.infer<typeof diskSample>;

export const networkSample = z.object({
  adapterId: z.string().max(128),
  name: z.string().max(200),
  kind: z.enum(['ethernet', 'wifi', 'loopback', 'virtual', 'other']).default('other'),
  up: z.boolean(),
  receiveBytesPerSecond: bytes,
  sendBytesPerSecond: bytes,
  linkSpeedBitsPerSecond: z.number().nonnegative().nullable(),
  /** Wi-Fi signal quality; null on wired adapters. */
  signalPercent: percent,
});
export type NetworkSample = z.infer<typeof networkSample>;

export const thermalSample = z.object({
  sensor: z.string().max(120),
  temperatureCelsius: celsius,
});
export type ThermalSample = z.infer<typeof thermalSample>;

export const batterySample = z.object({
  present: z.boolean(),
  chargePercent: percent,
  charging: z.boolean().nullable(),
  /** Estimated runtime remaining in seconds; null while charging or unknown. */
  runtimeSecondsRemaining: z.number().nonnegative().nullable(),
  healthPercent: percent,
});
export type BatterySample = z.infer<typeof batterySample>;

/** Resource cost of WOLF itself, so the agent can be held to its own budget. */
export const agentSelfSample = z.object({
  cpuPercent: percent,
  memoryBytes: bytes,
  /** Bytes moved by WOLF over the network in the sampling window. */
  networkBytesPerSecond: bytes,
  captureActive: z.boolean(),
  encoderActive: z.boolean(),
});
export type AgentSelfSample = z.infer<typeof agentSelfSample>;

/** One complete sampling tick from an agent. */
export const telemetrySample = z.object({
  sampledAt: isoDateTime,
  uptimeSeconds: z.number().nonnegative().nullable(),
  cpu: cpuSample,
  memory: memorySample,
  gpus: z.array(gpuSample).max(8).default([]),
  disks: z.array(diskSample).max(32).default([]),
  networks: z.array(networkSample).max(32).default([]),
  thermal: z.array(thermalSample).max(64).default([]),
  battery: batterySample.nullable(),
  agent: agentSelfSample.nullable(),
});
export type TelemetrySample = z.infer<typeof telemetrySample>;

/** Batched upload from an agent, ordered oldest-first. */
export const telemetryBatch = z.object({
  samples: z.array(telemetrySample).min(1).max(600),
  /** True when these samples were buffered locally during a cloud outage. */
  backfill: z.boolean().default(false),
});
export type TelemetryBatch = z.infer<typeof telemetryBatch>;
