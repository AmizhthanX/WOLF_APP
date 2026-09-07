/**
 * Syntactic safety checks for Windows paths.
 *
 * This module is the first of two gates. It rejects paths that are malformed, that escape
 * their root, that address Windows device namespaces, or that hide an alternate data
 * stream. It CANNOT decide whether a path is a symlink, junction, or reparse point — that
 * requires touching the filesystem and is enforced by the agent before every file
 * operation. Never treat a pass here as authorization to act on a path.
 */

/**
 * Reserved DOS device names. Any path segment equal to one of these (with or without an
 * extension) is refused, because Windows resolves it to a device rather than a file.
 */
const RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/** Paths under these roots require the strongest confirmation before modification. */
const PROTECTED_PREFIXES = [
  'C:\\WINDOWS',
  'C:\\PROGRAM FILES',
  'C:\\PROGRAM FILES (X86)',
  'C:\\PROGRAMDATA',
  'C:\\SYSTEM VOLUME INFORMATION',
  'C:\\$RECYCLE.BIN',
  'C:\\RECOVERY',
  'C:\\BOOT',
  'C:\\EFI',
  'C:\\PERFLOGS',
];

export type PathRejectionReason =
  | 'empty'
  | 'not-absolute'
  | 'traversal'
  | 'device-namespace'
  | 'reserved-name'
  | 'alternate-data-stream'
  | 'invalid-character'
  | 'trailing-dot-or-space'
  | 'too-long'
  | 'wildcard';

export interface PathValidationSuccess {
  readonly ok: true;
  /** Canonical form: uppercase drive letter, backslash separators, no trailing separator. */
  readonly normalized: string;
  /** True when the path sits inside a Windows-owned or otherwise protected location. */
  readonly protectedLocation: boolean;
  /** True when the path is a drive or UNC share root. */
  readonly isRoot: boolean;
}

export interface PathValidationFailure {
  readonly ok: false;
  readonly reason: PathRejectionReason;
  readonly message: string;
}

export type PathValidationResult = PathValidationSuccess | PathValidationFailure;

/** Windows long-path-aware APIs allow ~32767 characters. We cap well below that. */
const MAX_PATH_LENGTH = 4096;

function fail(reason: PathRejectionReason, message: string): PathValidationFailure {
  return { ok: false, reason, message };
}

export interface ValidatePathOptions {
  /** Allow `*` and `?`, e.g. for a search filter. Off by default. */
  readonly allowWildcards?: boolean;
}

/**
 * Validate and canonicalize an absolute Windows path.
 *
 * Accepts drive-letter paths and UNC paths. Rejects everything else, including
 * extended-length and device-namespace prefixes, which exist precisely to bypass the
 * normalization rules this function relies on.
 */
export function validateWindowsPath(
  input: string,
  options: ValidatePathOptions = {},
): PathValidationResult {
  if (typeof input !== 'string' || input.trim().length === 0) {
    return fail('empty', 'Path must not be empty.');
  }
  if (input.length > MAX_PATH_LENGTH) {
    return fail('too-long', 'Path is longer than WOLF accepts.');
  }
  if (/[\u0000-\u001f]/.test(input)) {
    return fail('invalid-character', 'Path must not contain control characters.');
  }
  const unified = input.replace(/\//g, '\\');

  // Checked before the wildcard rule: the `\\?\` prefix contains a `?`, and reporting it
  // as a stray wildcard would hide the real reason the path was refused.
  if (unified.startsWith('\\\\?\\') || unified.startsWith('\\\\.\\')) {
    return fail(
      'device-namespace',
      'Extended-length and device-namespace paths are not accepted because they bypass path normalization.',
    );
  }

  if (!options.allowWildcards && /[*?]/.test(unified)) {
    return fail('wildcard', 'Path must not contain wildcards.');
  }
  if (/["<>|]/.test(unified)) {
    return fail('invalid-character', 'Path contains characters that are illegal on Windows.');
  }

  let prefix: string;
  let rest: string;
  let isUnc = false;

  const driveMatch = /^([A-Za-z]):\\(.*)$/.exec(unified);
  if (driveMatch) {
    prefix = driveMatch[1]!.toUpperCase() + ':';
    rest = driveMatch[2]!;
  } else if (unified.startsWith('\\\\')) {
    const uncMatch = /^\\\\([^\\]+)\\([^\\]+)(?:\\(.*))?$/.exec(unified);
    if (!uncMatch) {
      return fail('not-absolute', 'UNC paths must include a server and a share name.');
    }
    isUnc = true;
    prefix = '\\\\' + uncMatch[1] + '\\' + uncMatch[2];
    rest = uncMatch[3] ?? '';
  } else {
    return fail(
      'not-absolute',
      'Path must be absolute: a drive path such as C:\\Users, or a UNC path.',
    );
  }

  const segments: string[] = [];
  for (const raw of rest.split('\\')) {
    if (raw === '' || raw === '.') continue;
    if (raw === '..') {
      // Reject rather than resolve: a request that needs to climb out of its own root is
      // either a bug or an attack, and silently resolving it hides both.
      return fail('traversal', 'Path must not contain ".." segments.');
    }
    if (raw.includes(':')) {
      return fail('alternate-data-stream', 'Path must not reference an alternate data stream.');
    }
    if (raw !== raw.replace(/[. ]+$/, '')) {
      // Windows silently strips trailing dots and spaces, so "evil.exe." and "evil.exe"
      // are the same file but compare differently against an allow list.
      return fail('trailing-dot-or-space', 'Path segments must not end with a dot or space.');
    }
    const bare = (raw.split('.')[0] ?? '').toUpperCase();
    if (RESERVED_NAMES.has(bare)) {
      return fail('reserved-name', 'Path uses a reserved Windows device name.');
    }
    segments.push(raw);
  }

  const normalized =
    segments.length === 0
      ? isUnc
        ? prefix
        : prefix + '\\'
      : prefix + '\\' + segments.join('\\');

  return {
    ok: true,
    normalized,
    protectedLocation: isProtectedPath(normalized),
    isRoot: segments.length === 0,
  };
}

/** Case-insensitive comparison key for a normalized path. */
function comparisonKey(path: string): string {
  return path.toUpperCase().replace(/\\+$/, '');
}

/** True when the normalized path is inside (or equal to) a Windows-protected location. */
export function isProtectedPath(normalizedPath: string): boolean {
  const upper = comparisonKey(normalizedPath);
  // A drive root itself is protected: recursive operations there are never routine.
  if (/^[A-Z]:$/.test(upper)) return true;
  return PROTECTED_PREFIXES.some((prefix) => upper === prefix || upper.startsWith(prefix + '\\'));
}

/**
 * True when `candidate` is contained within `base`. Both must already be normalized by
 * `validateWindowsPath`. Used to confine file browsing and transfers to an allowed root.
 */
export function isWithin(base: string, candidate: string): boolean {
  const baseKey = comparisonKey(base);
  const candidateKey = comparisonKey(candidate);
  if (candidateKey === baseKey) return true;
  return candidateKey.startsWith(baseKey + '\\');
}

/** Validate a single file or directory name (no separators). */
export function validateFileName(name: string): PathValidationResult {
  if (!name || name.trim().length === 0) return fail('empty', 'Name must not be empty.');
  if (/[\\/]/.test(name)) return fail('invalid-character', 'Name must not contain separators.');
  return validateWindowsPath('C:\\' + name);
}
