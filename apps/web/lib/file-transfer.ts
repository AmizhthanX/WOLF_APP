import {
  FileRefusal,
  MAX_FILE_CHUNK,
  type FileChunk,
  type FileInfo,
  type FileWritten,
} from './remote-desktop.ts';

/**
 * Moving one file between this tab and the PC, in a way that survives the connection dropping.
 *
 * A stream on somebody's home internet ends halfway through a 2 GB installer, and the one that
 * replaces it is a new stream. What used to happen is the transfer started again from nothing.
 * What happens now is that an interruption — and only an interruption — leaves a record of how
 * far it got:
 *
 * - **Onto the PC**, the part file stays on the PC for {@link PARTIAL_UPLOAD_KEPT_MINUTES}
 *   minutes. Resuming asks the PC how much of it is there and sends the rest. With the last chunk
 *   goes this tab's own checksum of the whole file, and a file that does not match is not put in
 *   place.
 * - **Off the PC**, what already arrived stays in this tab. Resuming checks the file on the PC is
 *   still the same size and modification time before asking for the rest, because the second
 *   half of a different file joined to the first half of this one is not a file anybody had.
 *
 * Pressing Stop is not an interruption. It removes the part file at once.
 */

/** Mirrors `PARTIAL_UPLOAD_KEPT_SECONDS` in `packages/protocol`. */
export const PARTIAL_UPLOAD_KEPT_MINUTES = 30;

/**
 * Above this, the whole-file checksum is not computed in the tab.
 *
 * The browser's digest is not incremental, so checking a file means holding all of it in memory
 * at once. A resumed upload larger than this still has every chunk checked; what it lacks is the
 * end-to-end comparison, and the panel says so rather than implying it.
 */
export const WHOLE_FILE_CHECK_LIMIT = 512 * 1024 * 1024;

/** The part of a remote-desktop stream a transfer needs. */
export interface FileEndpoint {
  statFile(path: string): Promise<FileInfo>;
  readFile(path: string, offset: number, length: number): Promise<FileChunk>;
  writeFile(options: {
    transferId: string;
    path: string;
    offset: number;
    bytes: Uint8Array;
    final: boolean;
    overwrite: boolean;
    totalBytes: number;
    fileSha256?: string | null;
  }): Promise<FileWritten>;
  cancelTransfer(transferId: string): Promise<void>;
}

export interface InterruptedUpload {
  readonly kind: 'upload';
  readonly name: string;
  readonly file: Blob;
  readonly destination: string;
  readonly done: number;
}

export interface InterruptedDownload {
  readonly kind: 'download';
  readonly name: string;
  readonly path: string;
  readonly parts: readonly Uint8Array[];
  readonly done: number;
  readonly total: number;
  readonly modifiedAt: string | null;
}

export type InterruptedTransfer = InterruptedUpload | InterruptedDownload;

/** The connection went away mid-transfer. Carries what is needed to carry on. */
export class TransferInterrupted extends Error {
  constructor(readonly record: InterruptedTransfer) {
    super(
      `${record.kind === 'upload' ? 'Sending' : 'Fetching'} ${record.name} was interrupted when the connection to the PC ended.`,
    );
    this.name = 'TransferInterrupted';
  }
}

/** The connection ending, as opposed to the PC refusing something. */
export function isInterruption(error: unknown): boolean {
  return error instanceof FileRefusal && error.reason === 'interrupted';
}

export interface UploadResult {
  readonly outcome: 'written' | 'stopped';
  /** Whether this tab's checksum of the whole file was compared with the PC's before it was put in place. */
  readonly checkedWholeFile: boolean;
}

export async function uploadFile(
  endpoint: FileEndpoint,
  options: {
    readonly file: Blob;
    readonly name: string;
    readonly destination: string;
    readonly transferId: string;
    readonly startOffset?: number;
    readonly cancelled: () => boolean;
    readonly onProgress: (done: number, total: number) => void;
  },
): Promise<UploadResult> {
  const { file, destination, transferId } = options;
  const checkWholeFile = file.size <= WHOLE_FILE_CHECK_LIMIT;
  let offset = options.startOffset ?? 0;

  try {
    for (;;) {
      if (options.cancelled()) {
        await endpoint.cancelTransfer(transferId);
        return { outcome: 'stopped', checkedWholeFile: false };
      }

      const end = Math.min(offset + MAX_FILE_CHUNK, file.size);
      const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
      const final = end >= file.size;

      const written = await endpoint.writeFile({
        transferId,
        path: destination,
        offset,
        bytes,
        final,
        // Never by default. An operator replacing somebody's file should have said so.
        overwrite: false,
        totalBytes: file.size,
        fileSha256: final && checkWholeFile ? await digestOf(file) : null,
      });

      // The PC says where it actually is, which is how a chunk that arrived out of order
      // corrects itself instead of leaving a hole.
      offset = written.bytesWritten;
      options.onProgress(offset, file.size);

      if (written.complete) return { outcome: 'written', checkedWholeFile: checkWholeFile };
      if (final) throw new Error('The PC did not confirm the last part of that file.');
    }
  } catch (error) {
    if (isInterruption(error)) {
      // Not cancelled on the PC: that would delete exactly the part a resume needs, and there
      // is no connection to send it on anyway.
      throw new TransferInterrupted({
        kind: 'upload',
        name: options.name,
        file,
        destination,
        done: offset,
      });
    }

    await endpoint.cancelTransfer(transferId).catch(() => {});
    throw error;
  }
}

/**
 * Carry on with an upload a lost connection interrupted.
 *
 * The PC is asked how much of the part file it still has, because it is the only one that knows:
 * the last chunk this tab sent may or may not have landed, and the part file may have been cleared
 * since. Whatever it says is where this carries on from — from nothing, if nothing is left.
 */
export async function resumeUpload(
  endpoint: FileEndpoint,
  record: InterruptedUpload,
  options: {
    readonly transferId: string;
    readonly cancelled: () => boolean;
    readonly onProgress: (done: number, total: number) => void;
  },
): Promise<UploadResult & { readonly resumedFrom: number }> {
  const info = await endpoint.statFile(record.destination);

  if (info.entry !== null) {
    throw new FileRefusal(
      'exists',
      `A file named ${record.name} is already in that folder on the PC, so this one was not sent over it.`,
      false,
    );
  }

  // At least the last byte is sent again, so there is always a final chunk for the PC to check
  // the whole file against — even when the part file is already complete.
  const partial = info.partialBytes ?? 0;
  const resumedFrom = record.file.size === 0 ? 0 : Math.min(partial, record.file.size - 1);

  const result = await uploadFile(endpoint, {
    file: record.file,
    name: record.name,
    destination: record.destination,
    transferId: options.transferId,
    startOffset: resumedFrom,
    cancelled: options.cancelled,
    onProgress: options.onProgress,
  });

  return { ...result, resumedFrom };
}

export interface DownloadResult {
  readonly outcome: 'fetched' | 'stopped';
  readonly parts: readonly Uint8Array[];
}

export async function downloadFile(
  endpoint: FileEndpoint,
  options: {
    readonly path: string;
    readonly name: string;
    readonly modifiedAt: string | null;
    readonly parts?: readonly Uint8Array[];
    readonly startOffset?: number;
    readonly expectedTotal?: number;
    readonly cancelled: () => boolean;
    readonly onProgress: (done: number, total: number) => void;
  },
): Promise<DownloadResult> {
  const parts = [...(options.parts ?? [])];
  let offset = options.startOffset ?? 0;
  let total = options.expectedTotal ?? 0;

  try {
    for (;;) {
      if (options.cancelled()) return { outcome: 'stopped', parts: [] };

      const chunk = await endpoint.readFile(options.path, offset, MAX_FILE_CHUNK);

      if (options.expectedTotal !== undefined && chunk.totalBytes !== options.expectedTotal) {
        throw new FileRefusal(
          'changed',
          `${options.name} changed size on the PC partway through, so what arrived was discarded. Fetch it again.`,
          false,
        );
      }

      parts.push(chunk.bytes);
      offset += chunk.bytes.length;
      total = chunk.totalBytes;
      options.onProgress(offset, total);

      if (chunk.eof) return { outcome: 'fetched', parts };

      // A file that never reports the end would otherwise loop forever on a chunk of
      // nothing, which is a browser tab that stops responding rather than an error.
      if (chunk.bytes.length === 0) throw new Error('The PC stopped sending that file.');
    }
  } catch (error) {
    if (isInterruption(error)) {
      throw new TransferInterrupted({
        kind: 'download',
        name: options.name,
        path: options.path,
        parts,
        done: offset,
        total,
        modifiedAt: options.modifiedAt,
      });
    }

    throw error;
  }
}

/**
 * Carry on with a download a lost connection interrupted — if the file is still the one that was
 * being fetched. Same size and same modification time, or it starts again from nothing.
 */
export async function resumeDownload(
  endpoint: FileEndpoint,
  record: InterruptedDownload,
  options: {
    readonly cancelled: () => boolean;
    readonly onProgress: (done: number, total: number) => void;
  },
): Promise<DownloadResult> {
  const info = await endpoint.statFile(record.path);

  if (info.entry === null) {
    throw new FileRefusal('not-found', `${record.name} is no longer on the PC.`, false);
  }

  if (info.entry.sizeBytes !== record.total || info.entry.modifiedAt !== record.modifiedAt) {
    throw new FileRefusal(
      'changed',
      `${record.name} has changed on the PC since it was being fetched, so the part that arrived was discarded. Fetch it again.`,
      false,
    );
  }

  return downloadFile(endpoint, {
    path: record.path,
    name: record.name,
    modifiedAt: record.modifiedAt,
    parts: record.parts,
    startOffset: record.done,
    expectedTotal: record.total,
    cancelled: options.cancelled,
    onProgress: options.onProgress,
  });
}

async function digestOf(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
