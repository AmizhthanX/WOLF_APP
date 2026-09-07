import { z } from 'zod';

/**
 * Configuration comes from the environment and is validated once at startup. A service
 * that cannot be configured safely refuses to start rather than running with a weak
 * default — there is no fallback signing secret and no "dev mode" that skips auth.
 */
const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  HOST: z.string().default('0.0.0.0'),

  /** Postgres connection string. */
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_SSL: z
    .enum(['disable', 'require'])
    .default('disable'),

  /** Access-token signing secret; at least 32 bytes of real entropy. */
  WOLF_TOKEN_SECRET: z.string().min(32, 'WOLF_TOKEN_SECRET must be at least 32 characters'),
  WOLF_TOKEN_ISSUER: z.string().url().default('https://api.amizhthan.app'),
  WOLF_TOKEN_AUDIENCE: z.string().min(1).default('wolf-client'),

  /** Comma-separated list of origins allowed to call the API from a browser. */
  WOLF_ALLOWED_ORIGINS: z.string().default('https://amizhthan.app'),

  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  /** Maximum accepted clock drift for agent-reported timestamps, in seconds. */
  WOLF_MAX_CLOCK_DRIFT_SECONDS: z.coerce.number().int().min(5).max(3600).default(300),

  /** How long a dispatched command may wait for its agent before it expires. */
  WOLF_COMMAND_TTL_SECONDS: z.coerce.number().int().min(5).max(3600).default(120),

  /** Session lifetime before it must be renewed. */
  WOLF_SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3600),

  /**
   * STUN servers, comma separated. Empty by default on purpose: a public STUN server is a
   * third party that learns the owner's address every time a stream starts, and WOLF does
   * not opt anyone into that silently. LAN streaming works without one; reaching a PC over
   * the internet needs STUN, and self-hosted coturn provides both STUN and TURN.
   */
  WOLF_STUN_URLS: z.string().default(''),

  /** TURN servers, comma separated. The relay fallback when a direct path cannot form. */
  WOLF_TURN_URLS: z.string().default(''),

  /**
   * Shared secret for TURN REST credentials (coturn's `static-auth-secret`). Credentials
   * are derived per request and expire on their own, so nothing per-session is stored and
   * a leaked credential stops working by itself.
   */
  WOLF_TURN_SECRET: z.string().default(''),

  WOLF_TURN_CREDENTIAL_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3600),
});

export type Environment = z.infer<typeof environmentSchema>;

export interface Config {
  readonly env: Environment['NODE_ENV'];
  readonly isProduction: boolean;
  readonly port: number;
  readonly host: string;
  readonly database: {
    readonly url: string;
    readonly poolMax: number;
    readonly ssl: boolean;
  };
  readonly tokens: {
    readonly secret: string;
    readonly issuer: string;
    readonly audience: string;
  };
  readonly allowedOrigins: readonly string[];
  readonly logLevel: Environment['LOG_LEVEL'];
  readonly maxClockDriftSeconds: number;
  readonly commandTtlSeconds: number;
  readonly sessionTtlSeconds: number;
  readonly ice: {
    readonly stunUrls: readonly string[];
    readonly turnUrls: readonly string[];
    readonly turnSecret: string;
    readonly turnCredentialTtlSeconds: number;
    /** True when a stream can reach a PC that is not on the same network. */
    readonly internetCapable: boolean;
  };
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = environmentSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new ConfigurationError(`Invalid API configuration — ${details}`);
  }
  const env = parsed.data;

  const origins = env.WOLF_ALLOWED_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  if (env.NODE_ENV === 'production') {
    if (origins.some((origin) => origin === '*')) {
      throw new ConfigurationError('WOLF_ALLOWED_ORIGINS must not be "*" in production.');
    }
    if (origins.some((origin) => origin.startsWith('http://') && !origin.includes('localhost'))) {
      throw new ConfigurationError('Production origins must use HTTPS.');
    }
  }

  const splitList = (value: string): string[] =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

  const stunUrls = splitList(env.WOLF_STUN_URLS);
  const turnUrls = splitList(env.WOLF_TURN_URLS);

  if (turnUrls.length > 0 && env.WOLF_TURN_SECRET.length < 16) {
    throw new ConfigurationError(
      'WOLF_TURN_SECRET must be set (at least 16 characters) when TURN servers are configured.',
    );
  }

  return {
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    port: env.PORT,
    host: env.HOST,
    database: {
      url: env.DATABASE_URL,
      poolMax: env.DATABASE_POOL_MAX,
      ssl: env.DATABASE_SSL === 'require',
    },
    tokens: {
      secret: env.WOLF_TOKEN_SECRET,
      issuer: env.WOLF_TOKEN_ISSUER,
      audience: env.WOLF_TOKEN_AUDIENCE,
    },
    allowedOrigins: origins,
    logLevel: env.LOG_LEVEL,
    maxClockDriftSeconds: env.WOLF_MAX_CLOCK_DRIFT_SECONDS,
    commandTtlSeconds: env.WOLF_COMMAND_TTL_SECONDS,
    sessionTtlSeconds: env.WOLF_SESSION_TTL_SECONDS,
    ice: {
      stunUrls,
      turnUrls,
      turnSecret: env.WOLF_TURN_SECRET,
      turnCredentialTtlSeconds: env.WOLF_TURN_CREDENTIAL_TTL_SECONDS,
      // Without at least a STUN server, ICE can only use host candidates, which means
      // streaming works on the same network and nowhere else.
      internetCapable: stunUrls.length > 0 || turnUrls.length > 0,
    },
  };
}
