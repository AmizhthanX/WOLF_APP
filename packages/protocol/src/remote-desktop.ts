import { z } from 'zod';
import { displayName, isoDateTime, wolfId } from '@wolf/validation';
import { CONNECTION_ROUTES, REMOTE_DESKTOP_STATES } from '@wolf/shared-types';

/**
 * Remote desktop stream contract.
 *
 * Nothing here assumes a codec, a resolution, or an encoder. The agent reports what the
 * machine actually has, the browser reports what it can actually decode, and the
 * intersection decides — because "every Windows GPU supports H.265" and "every browser
 * decodes AV1" are both false, and a product that assumes either produces a black screen
 * on the machine that matters.
 */

export const VIDEO_CODECS = ['av1', 'h265', 'h264', 'vp9', 'vp8'] as const;
export const videoCodec = z.enum(VIDEO_CODECS);
export type VideoCodec = z.infer<typeof videoCodec>;

/**
 * Preference order used when both sides support several codecs.
 *
 * H.264 sits above VP9 and VP8 deliberately. AV1 and H.265 are better when both ends have
 * hardware for them, but H.264 is decoded in hardware by every browser and every GPU of
 * the last decade — a stream that is merely good everywhere beats one that is excellent on
 * one machine and unwatchable on the next.
 */
export const CODEC_PREFERENCE_ORDER: readonly VideoCodec[] = VIDEO_CODECS;

export const AUDIO_CODECS = ['opus'] as const;
export const audioCodec = z.enum(AUDIO_CODECS);

/** A display the agent can capture. */
export const displayInfo = z.object({
  /** Stable identifier for this output, e.g. the adapter/output path. */
  id: z.string().min(1).max(256),
  name: z.string().max(200),
  widthPixels: z.number().int().min(1).max(32_768),
  heightPixels: z.number().int().min(1).max(32_768),
  refreshHz: z.number().min(1).max(1000).nullable(),
  primary: z.boolean(),
  /** Windows display scaling, e.g. 1.5 for 150%. */
  scaleFactor: z.number().min(0.25).max(8).nullable(),
  hdr: z.boolean().default(false),
  /** Virtual desktop position, so a multi-monitor client can lay them out. */
  originX: z.number().int(),
  originY: z.number().int(),
});
export type DisplayInfo = z.infer<typeof displayInfo>;

export const QUALITY_BIAS = ['quality', 'balanced', 'performance'] as const;
export const qualityBias = z.enum(QUALITY_BIAS);
export type QualityBias = z.infer<typeof qualityBias>;

/**
 * A saved set of streaming preferences.
 *
 * Every field is a ceiling or a target, never a guarantee. When the machine or the network
 * cannot meet a pinned value, WOLF reports that it is running below the profile rather
 * than silently ignoring the setting.
 */
export const remoteDesktopProfile = z.object({
  name: displayName,
  /** Cap the streamed resolution. Null means the display's native resolution. */
  maxWidthPixels: z.number().int().min(320).max(7680).nullable().default(null),
  maxHeightPixels: z.number().int().min(240).max(4320).nullable().default(null),
  targetFps: z.number().int().min(1).max(240).default(60),
  minBitrateBps: z.number().int().min(100_000).max(200_000_000).default(1_000_000),
  maxBitrateBps: z.number().int().min(100_000).max(200_000_000).default(40_000_000),
  /** Ordered client preference; the agent still only offers what it has. */
  codecPreference: z.array(videoCodec).max(VIDEO_CODECS.length).default([]),
  audioEnabled: z.boolean().default(true),
  qualityBias: qualityBias.default('balanced'),
  /**
   * Adaptive is the default. Turning it off pins the profile, which is useful on a LAN and
   * a poor idea over a congested link.
   */
  adaptive: z.boolean().default(true),
})
  .refine((profile) => profile.maxBitrateBps >= profile.minBitrateBps, {
    message: 'maxBitrateBps must be at least minBitrateBps',
    path: ['maxBitrateBps'],
  })
  .refine(
    (profile) =>
      (profile.maxWidthPixels === null) === (profile.maxHeightPixels === null),
    {
      message: 'set both maxWidthPixels and maxHeightPixels, or neither',
      path: ['maxHeightPixels'],
    },
  );
export type RemoteDesktopProfile = z.infer<typeof remoteDesktopProfile>;

/** The profiles WOLF ships with. Users can add their own. */
export const BUILT_IN_PROFILES: Readonly<Record<string, RemoteDesktopProfile>> = Object.freeze({
  'lan-maximum-quality': remoteDesktopProfile.parse({
    name: 'LAN — Maximum Quality',
    targetFps: 60,
    minBitrateBps: 8_000_000,
    maxBitrateBps: 80_000_000,
    qualityBias: 'quality',
    audioEnabled: true,
    adaptive: true,
  }),
  'internet-balanced': remoteDesktopProfile.parse({
    name: 'Internet — Balanced',
    targetFps: 60,
    minBitrateBps: 1_500_000,
    maxBitrateBps: 20_000_000,
    qualityBias: 'balanced',
    audioEnabled: true,
    adaptive: true,
  }),
  'mobile-low-bandwidth': remoteDesktopProfile.parse({
    name: 'Mobile Data — Low Bandwidth',
    maxWidthPixels: 1280,
    maxHeightPixels: 720,
    targetFps: 30,
    minBitrateBps: 400_000,
    maxBitrateBps: 3_000_000,
    qualityBias: 'performance',
    audioEnabled: false,
    adaptive: true,
  }),
});

/** What the client asks for when starting a stream. */
export const streamRequest = z.object({
  /** Display to capture. Null means the primary display. */
  displayId: z.string().max(256).nullable().default(null),
  profile: remoteDesktopProfile,
  /** Codecs the client can decode, in its own preference order. */
  clientCodecs: z.array(videoCodec).min(1).max(VIDEO_CODECS.length),
  /** Client asks for audio; the agent still refuses if it cannot capture any. */
  requestAudio: z.boolean().default(true),
});
export type StreamRequest = z.infer<typeof streamRequest>;

/** What the agent settled on. The client renders what this says, not what it asked for. */
export const streamNegotiation = z.object({
  streamId: wolfId,
  display: displayInfo,
  videoCodec,
  /** True when the negotiated codec is encoded in hardware on this PC. */
  hardwareEncoded: z.boolean(),
  audioCodec: audioCodec.nullable(),
  /** Effective profile after clamping to what the machine can do. */
  effectiveProfile: remoteDesktopProfile,
  /**
   * Set when the effective profile differs from what was asked for, so the UI can say
   * which setting could not be honoured and why.
   */
  adjustments: z
    .array(
      z.object({
        setting: z.string().max(64),
        requested: z.string().max(64),
        applied: z.string().max(64),
        reason: z.string().max(200),
      }),
    )
    .max(16)
    .default([]),
  startedAt: isoDateTime,
});
export type StreamNegotiation = z.infer<typeof streamNegotiation>;

export const streamState = z.enum(REMOTE_DESKTOP_STATES);
export type StreamState = z.infer<typeof streamState>;

/**
 * Live stream statistics, surfaced to the operator.
 *
 * These exist so "why is this laggy" has an answer on screen. Every field is nullable
 * because a stat that has not been measured yet is not zero.
 */
export const streamStats = z.object({
  streamId: wolfId,
  at: isoDateTime,
  state: streamState,
  route: z.enum(CONNECTION_ROUTES).nullable(),
  /** Frames actually delivered per second, not the target. */
  fps: z.number().min(0).max(1000).nullable(),
  bitrateBps: z.number().min(0).nullable(),
  widthPixels: z.number().int().min(0).nullable(),
  heightPixels: z.number().int().min(0).nullable(),
  /** Round-trip time as reported by the transport. */
  latencyMs: z.number().min(0).nullable(),
  jitterMs: z.number().min(0).nullable(),
  packetLossPercent: z.number().min(0).max(100).nullable(),
  keyFramesSent: z.number().int().min(0).nullable(),
  /** Encoder in use, e.g. "h264-qsv" or "h264-software". */
  encoder: z.string().max(64).nullable(),
  encoderHardware: z.boolean().nullable(),
  /** Encode time per frame; the number that says whether the PC is the bottleneck. */
  encodeMsPerFrame: z.number().min(0).nullable(),
  /** Set whenever the state is DEGRADED, so the UI never has to guess. */
  degradedReason: z
    .enum([
      'bandwidth',
      'packet-loss',
      'encoder-overloaded',
      'capture-slow',
      'cpu-saturated',
      'profile-unsupported',
    ])
    .nullable()
    .default(null),
});
export type StreamStats = z.infer<typeof streamStats>;

/**
 * Why a stream cannot run, when it cannot.
 *
 * These are reported instead of a black frame. `locked`, `login`, and `signed-out` are the
 * Windows session boundaries a user-session capture process cannot cross; they are normal
 * conditions, not errors.
 */
export const STREAM_UNAVAILABLE_REASONS = [
  'locked',
  'login',
  'signed-out',
  'restarting',
  'no-session-host',
  'no-display',
  'capture-unsupported',
  'no-encoder',
  /**
   * The PC can capture and encode, but cannot yet carry the result to a client. Distinct
   * from `capture-unsupported` because the fix is different and so is the diagnosis.
   */
  'transport-unavailable',
  'codec-mismatch',
  'kill-switch',
] as const;
export const streamUnavailableReason = z.enum(STREAM_UNAVAILABLE_REASONS);
export type StreamUnavailableReason = z.infer<typeof streamUnavailableReason>;

/** Session boundaries the operator can wait out, as opposed to faults they must fix. */
export const TRANSIENT_UNAVAILABLE_REASONS: readonly StreamUnavailableReason[] = [
  'locked',
  'login',
  'signed-out',
  'restarting',
];

export function isTransientUnavailable(reason: StreamUnavailableReason): boolean {
  return TRANSIENT_UNAVAILABLE_REASONS.includes(reason);
}

/**
 * Pick the codec both sides support, preferring the best mutually available option.
 *
 * Returns null when there is no overlap at all, which the caller must surface as
 * `codec-mismatch` rather than falling back to something the client cannot decode.
 */
export function negotiateCodec(
  agentCodecs: readonly VideoCodec[],
  clientCodecs: readonly VideoCodec[],
  clientPreference: readonly VideoCodec[] = [],
): VideoCodec | null {
  const mutual = new Set(agentCodecs.filter((codec) => clientCodecs.includes(codec)));
  if (mutual.size === 0) return null;

  // The client's stated preference wins where it overlaps; otherwise fall back to the
  // product-wide order, which favours compatibility over peak efficiency.
  for (const codec of clientPreference) {
    if (mutual.has(codec)) return codec;
  }
  for (const codec of CODEC_PREFERENCE_ORDER) {
    if (mutual.has(codec)) return codec;
  }
  return null;
}
