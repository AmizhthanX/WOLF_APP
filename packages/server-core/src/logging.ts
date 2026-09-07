import { pino, type Logger, type LoggerOptions } from 'pino';
import { redact } from '@wolf/validation';
import type { Config } from './config.js';

/**
 * Structured logging.
 *
 * Every log record passes through the shared redactor, so a payload field named
 * `password`, `token`, `clipboardText`, or `stdout` cannot reach a log sink even if a new
 * call site forgets. Pino's own `redact` paths are set as a second layer for the request
 * fields we know about by name.
 */
const KNOWN_SENSITIVE_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-wolf-refresh-token"]',
  'res.headers["set-cookie"]',
  'password',
  'refreshToken',
  'accessToken',
  '*.password',
  '*.refreshToken',
  '*.accessToken',
];

export function createLogger(config: Config): Logger {
  const options: LoggerOptions = {
    level: config.logLevel,
    redact: { paths: KNOWN_SENSITIVE_PATHS, censor: '[redacted]' },
    formatters: {
      level: (label) => ({ level: label }),
    },
    // Cloud Logging reads this field as the severity timestamp.
    timestamp: pino.stdTimeFunctions.isoTime,
    base: { service: 'wolf-api' },
    hooks: {
      logMethod(args, method) {
        // Structural redaction of anything a call site passes as a merge object.
        if (args.length > 0 && typeof args[0] === 'object' && args[0] !== null) {
          args[0] = redact(args[0]) as object;
        }
        method.apply(this, args as Parameters<typeof method>);
      },
    },
  };

  return pino(options);
}
