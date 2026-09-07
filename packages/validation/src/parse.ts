import { z } from 'zod';
import { WolfError, type ErrorArea } from '@wolf/shared-types';

export interface ParseOptions {
  /** Subsystem used for the generated reference id. */
  readonly area?: ErrorArea;
  /** What the caller was trying to do, used in the problem statement. */
  readonly what?: string;
}

/** Condense a Zod issue list into a single human-readable cause, without echoing values. */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : 'request body';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

/**
 * Parse untrusted input against a schema, raising a `WolfError` that already carries a
 * problem, cause, current state, recommended action, and reference id.
 *
 * The rejected values themselves are never included: request bodies routinely carry
 * passwords and tokens, and validation failures are logged.
 */
export function parseOrThrow<T extends z.ZodTypeAny>(
  schema: T,
  input: unknown,
  options: ParseOptions = {},
): z.infer<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  const what = options.what ?? 'The request';
  throw new WolfError({
    code: 'validation.failed',
    problem: `${what} could not be accepted.`,
    cause: describeIssues(result.error),
    currentState: 'Nothing was changed.',
    recommendedAction: 'Correct the highlighted fields and try again.',
    area: options.area ?? 'API',
    httpStatus: 400,
    detail: { issueCount: result.error.issues.length },
  });
}

/** Non-throwing variant for call sites that branch on validity. */
export function parseSafe<T extends z.ZodTypeAny>(
  schema: T,
  input: unknown,
): { ok: true; value: z.infer<T> } | { ok: false; cause: string } {
  const result = schema.safeParse(input);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, cause: describeIssues(result.error) };
}
