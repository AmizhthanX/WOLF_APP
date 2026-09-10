import { z } from 'zod';
import { wolfId } from '@wolf/validation';

/**
 * Browsing a PC's disks, and moving files off them and onto them.
 *
 * ## Everything here rides the data channel
 *
 * Contents *and* names. The rule about contents is written down — WOLF must never persist
 * transferred file contents — but a directory listing is not innocent either: `Divorce
 * settlement.docx`, `resignation draft.docx`, `2019 tax return.pdf`. A server that never
 * receives a listing cannot store one, log one, or be compelled to produce one, and that is
 * a stronger promise than a retention policy.
 *
 * So the cloud decides *who may browse and transfer*, and records that a transfer happened
 * and how large it was. It never learns what was in it or what it was called.
 *
 * ## Chunked, checksummed, resumable
 *
 * A transfer is a sequence of offsets, not a stream. That is what makes it resumable across
 * a reconnect — and reconnects are the normal case, because the thing carrying these bytes
 * is a WebRTC data channel on somebody's home internet.
 *
 * Every chunk carries its own SHA-256. Not for security — the channel is already
 * DTLS-encrypted and authenticated — but because a file that arrives subtly wrong is worse
 * than one that fails: nobody notices until they try to use it, and by then the source may
 * be gone.
 *
 * ## What is not here
 *
 * Delete, rename and move. They are mutations with real blast radius, they belong on the
 * command path where risk levels and confirmations live, and putting them on this channel
 * would route them around the very machinery that exists to make them accountable.
 */

/**
 * The largest chunk WOLF moves in one message.
 *
 * Sized for the data channel rather than for throughput: SCTP negotiates a maximum message
 * size and the base64 encoding adds a third on top, so a chunk that looked reasonable as a
 * file size can be a message the transport silently refuses to send.
 */
export const MAX_FILE_CHUNK = 64 * 1024;

/** Entries returned for one directory. Past this the listing says it was truncated. */
export const MAX_DIRECTORY_ENTRIES = 2000;

/** How many transfers one stream may have in flight. */
export const MAX_CONCURRENT_TRANSFERS = 4;

/**
 * The largest file WOLF will move.
 *
 * A cap rather than no limit, because a transfer is held open on both ends and an accidental
 * 400 GB disk image is a session that never finishes and a PC whose disk fills with a partial
 * file nobody asked for.
 */
export const MAX_TRANSFER_BYTES = 8 * 1024 * 1024 * 1024;

export const FILE_ENTRY_KINDS = ['file', 'directory', 'drive'] as const;
export const fileEntryKind = z.enum(FILE_ENTRY_KINDS);
export type FileEntryKind = z.infer<typeof fileEntryKind>;

/**
 * One thing in a directory.
 *
 * `reparse` matters more than it looks. A junction or symlink is how a path that passed every
 * syntactic check ends up somewhere else entirely, so the agent resolves them and the client
 * is told which entries are one — an operator about to copy a folder should know when it is
 * really a link to somewhere else.
 */
export const fileEntry = z.object({
  name: z.string().min(1).max(512),
  kind: fileEntryKind,
  sizeBytes: z.number().int().min(0).nullable().default(null),
  modifiedAt: z.string().max(64).nullable().default(null),
  readOnly: z.boolean().default(false),
  hidden: z.boolean().default(false),
  /** True for a symlink, junction, or other reparse point. */
  reparse: z.boolean().default(false),
  /** True when the path sits under a Windows-owned location. */
  protectedLocation: z.boolean().default(false),
});
export type FileEntry = z.infer<typeof fileEntry>;

/* --------------------------------------------------------------------------- */
/* Client -> PC                                                                 */
/* --------------------------------------------------------------------------- */

/** List a directory, or the drives when `path` is null. */
export const fileList = z.object({
  kind: z.literal('file.list'),
  requestId: wolfId,
  path: z.string().max(4096).nullable().default(null),
});

/** What one path is, without listing anything. Used to resume an interrupted transfer. */
export const fileStat = z.object({
  kind: z.literal('file.stat'),
  requestId: wolfId,
  path: z.string().max(4096),
});

/**
 * Read part of a file.
 *
 * One chunk per request, and the client asks for the offset it wants. A push-based stream
 * would be fewer messages and would lose its place on every reconnect, which on this
 * transport is not an edge case.
 */
export const fileRead = z.object({
  kind: z.literal('file.read'),
  requestId: wolfId,
  path: z.string().max(4096),
  offset: z.number().int().min(0),
  length: z.number().int().min(1).max(MAX_FILE_CHUNK),
});

/**
 * Write part of a file.
 *
 * Chunks land in a `.wolfpart` file beside the destination and are renamed into place on the
 * last one. That is what makes an interrupted upload resumable — the partial file is the
 * record of how far it got — and it is also why a half-finished transfer never appears as the
 * real file: somebody double-clicking a 40%-complete installer is a worse outcome than a
 * transfer they have to restart.
 */
export const fileWrite = z.object({
  kind: z.literal('file.write'),
  requestId: wolfId,
  transferId: wolfId,
  path: z.string().max(4096),
  offset: z.number().int().min(0),
  /** Base64. Bounded so the decoded chunk cannot exceed `MAX_FILE_CHUNK`. */
  data: z.string().max(Math.ceil((MAX_FILE_CHUNK * 4) / 3) + 4),
  /** SHA-256 of the decoded bytes, lowercase hex. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** The last chunk. The part file is verified and renamed into place. */
  final: z.boolean().default(false),
  /**
   * Whether an existing file at the destination may be replaced.
   *
   * False by default, and checked when the transfer starts rather than when it finishes: an
   * operator who finds out they overwrote something after sending 3 GB has been told too
   * late to do anything about it.
   */
  overwrite: z.boolean().default(false),
  /** Total size, so the PC can refuse a transfer it has no room for before it begins. */
  totalBytes: z.number().int().min(0).max(MAX_TRANSFER_BYTES),
});

/** Abandon a transfer. The part file goes with it. */
export const fileCancel = z.object({
  kind: z.literal('file.cancel'),
  requestId: wolfId,
  transferId: wolfId,
});

/* --------------------------------------------------------------------------- */
/* PC -> client                                                                 */
/* --------------------------------------------------------------------------- */

export const fileListing = z.object({
  kind: z.literal('file.listing'),
  requestId: wolfId,
  /** Null when this is the list of drives. */
  path: z.string().max(4096).nullable().default(null),
  entries: z.array(fileEntry).max(MAX_DIRECTORY_ENTRIES),
  /**
   * True when the directory held more than WOLF will list.
   *
   * Said rather than silently cut: a folder that shows 2000 of its 40000 files, with no
   * indication, is one an operator will conclude does not contain what they are looking for.
   */
  truncated: z.boolean().default(false),
});

export const fileInfo = z.object({
  kind: z.literal('file.info'),
  requestId: wolfId,
  path: z.string().max(4096),
  entry: fileEntry.nullable().default(null),
  /**
   * Bytes already written to a partial upload at this path, when one exists.
   *
   * How a resumed upload finds its place. Null when there is no partial file.
   */
  partialBytes: z.number().int().min(0).nullable().default(null),
});

export const fileChunk = z.object({
  kind: z.literal('file.chunk'),
  requestId: wolfId,
  offset: z.number().int().min(0),
  /** Base64 of at most `MAX_FILE_CHUNK` bytes. */
  data: z.string().max(Math.ceil((MAX_FILE_CHUNK * 4) / 3) + 4),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** True when this chunk reaches the end of the file. */
  eof: z.boolean().default(false),
  /** The file's total size, so a client can show progress from the first chunk. */
  totalBytes: z.number().int().min(0),
});

export const fileWritten = z.object({
  kind: z.literal('file.written'),
  requestId: wolfId,
  transferId: wolfId,
  /** Bytes in the part file after this chunk — where a resumed transfer would continue. */
  bytesWritten: z.number().int().min(0),
  /** Set only on the final chunk: SHA-256 of the whole file as the PC received it. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
  /** True once the part file has been verified and renamed into place. */
  complete: z.boolean().default(false),
});

/**
 * Why a file operation did not happen.
 *
 * Always answered. An operator staring at a folder that will not open needs to know whether
 * WOLF refused it, Windows refused it, or it is simply not there — three different things
 * with three different next steps.
 */
export const fileRefused = z.object({
  kind: z.literal('file.refused'),
  requestId: wolfId,
  reason: z.enum([
    /** No `file-transfer` capability, or the lease is held elsewhere. */
    'not-permitted',
    /** The path failed a syntactic or filesystem check. */
    'rejected',
    'not-found',
    /** Windows said no. The signed-in user cannot read or write it. */
    'access-denied',
    /** A file is already there and the transfer did not ask to replace it. */
    'exists',
    /** Too large, too many at once, or no room on the disk. */
    'too-large',
    /** A chunk's checksum did not match what arrived. */
    'corrupt',
    /** WOLF does not do this — a network path, a device, an operation not built. */
    'unsupported',
    'failed',
  ]),
  detail: z.string().max(300),
  /** True when this is Windows saying no rather than WOLF. */
  limitation: z.boolean().default(false),
});

export const fileClientMessage = z.discriminatedUnion('kind', [
  fileList,
  fileStat,
  fileRead,
  fileWrite,
  fileCancel,
]);
export type FileClientMessage = z.infer<typeof fileClientMessage>;

export const fileAgentMessage = z.discriminatedUnion('kind', [
  fileListing,
  fileInfo,
  fileChunk,
  fileWritten,
  fileRefused,
]);
export type FileAgentMessage = z.infer<typeof fileAgentMessage>;
