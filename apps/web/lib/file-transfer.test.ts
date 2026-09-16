import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  downloadFile,
  isInterruption,
  resumeDownload,
  resumeUpload,
  TransferInterrupted,
  uploadFile,
  type FileEndpoint,
  type InterruptedDownload,
  type InterruptedUpload,
} from './file-transfer.js';
import { FileRefusal, MAX_FILE_CHUNK, type FileEntry } from './remote-desktop.js';

/**
 * Transfers that lose their connection partway, against a PC that behaves the way the session host
 * does: part files that survive the stream, contiguous offsets, a whole-file checksum that keeps a
 * mismatch out of place, and a connection that can be cut after any number of messages.
 */

const hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function randomBytes(length: number, seed: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) >>> 0;
    bytes[i] = state >>> 24;
  }
  return bytes;
}

class FakePc implements FileEndpoint {
  readonly files = new Map<string, { bytes: Uint8Array; modifiedAt: string }>();
  readonly parts = new Map<string, Uint8Array>();
  readonly cancelled: string[] = [];
  readonly writes: { offset: number; fileSha256: string | null | undefined; final: boolean }[] = [];
  private readonly inFlight = new Map<string, string>();

  /** Messages left before the connection drops. */
  connectionLeft = Number.POSITIVE_INFINITY;

  private spend(): void {
    if (this.connectionLeft <= 0) {
      throw new FileRefusal('interrupted', 'The connection to this PC ended.', false);
    }
    this.connectionLeft--;
  }

  /** A new stream: whatever was in flight is put aside, and its part files stay. */
  reconnect(): void {
    this.inFlight.clear();
    this.connectionLeft = Number.POSITIVE_INFINITY;
  }

  async statFile(path: string) {
    this.spend();
    const file = this.files.get(path);
    const entry: FileEntry | null = file
      ? ({
          name: path,
          kind: 'file',
          sizeBytes: file.bytes.length,
          modifiedAt: file.modifiedAt,
        } as unknown as FileEntry)
      : null;
    return { path, entry, partialBytes: this.parts.get(path)?.length ?? null };
  }

  async readFile(path: string, offset: number, length: number) {
    this.spend();
    const file = this.files.get(path);
    if (!file) throw new FileRefusal('not-found', 'Nothing there.', false);
    const bytes = file.bytes.slice(offset, offset + length);
    return {
      offset,
      bytes,
      eof: offset + bytes.length >= file.bytes.length,
      totalBytes: file.bytes.length,
    };
  }

  async writeFile(options: Parameters<FileEndpoint['writeFile']>[0]) {
    this.spend();
    this.writes.push({ offset: options.offset, fileSha256: options.fileSha256, final: options.final });

    let part = this.parts.get(options.path);
    if (!this.inFlight.has(options.transferId)) {
      if (options.offset > 0 && (!part || options.offset > part.length)) {
        throw new FileRefusal('rejected', 'That resume point is past the end of the partial file.', false);
      }
      part = options.offset === 0 ? new Uint8Array() : part!.slice(0, options.offset);
      this.inFlight.set(options.transferId, options.path);
    }
    if (options.offset !== part!.length) throw new FileRefusal('rejected', 'Gap.', false);

    const joined = new Uint8Array(part!.length + options.bytes.length);
    joined.set(part!);
    joined.set(options.bytes, part!.length);
    this.parts.set(options.path, joined);

    if (!options.final) return { bytesWritten: joined.length, sha256: null, complete: false };

    this.inFlight.delete(options.transferId);
    this.parts.delete(options.path);
    if (options.fileSha256 && options.fileSha256 !== hex(joined)) {
      throw new FileRefusal('corrupt', 'Does not match.', false);
    }
    this.files.set(options.path, { bytes: joined, modifiedAt: '2026-09-16T10:00:00.000Z' });
    return { bytesWritten: joined.length, sha256: hex(joined), complete: true };
  }

  async cancelTransfer(transferId: string) {
    this.spend();
    this.cancelled.push(transferId);
    const path = this.inFlight.get(transferId);
    if (path) this.parts.delete(path);
    this.inFlight.delete(transferId);
  }
}

const quiet = { cancelled: () => false, onProgress: () => {} };

async function interrupted<T>(work: Promise<unknown>): Promise<T> {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof TransferInterrupted, `expected an interruption, got ${String(error)}`);
    return error.record as T;
  }
  assert.fail('the transfer was expected to be interrupted');
}

test('an upload cut off partway carries on from what the PC kept, and lands the whole file', async () => {
  const contents = randomBytes(MAX_FILE_CHUNK * 3 + 123, 7);
  const pc = new FakePc();
  pc.connectionLeft = 2;

  const record = await interrupted<InterruptedUpload>(
    uploadFile(pc, {
      file: new Blob([contents]),
      name: 'setup.exe',
      destination: 'C:\\Users\\me\\setup.exe',
      transferId: 'first',
      ...quiet,
    }),
  );

  // Interrupted, not stopped: nothing was cancelled on the PC, and the part is still there.
  assert.equal(record.done, MAX_FILE_CHUNK * 2);
  assert.deepEqual(pc.cancelled, []);
  assert.equal(pc.parts.get('C:\\Users\\me\\setup.exe')?.length, MAX_FILE_CHUNK * 2);

  pc.reconnect();
  const before = pc.writes.length;
  const result = await resumeUpload(pc, record, { transferId: 'second', ...quiet });

  assert.equal(result.outcome, 'written');
  assert.equal(result.resumedFrom, MAX_FILE_CHUNK * 2);
  assert.equal(pc.writes[before]!.offset, MAX_FILE_CHUNK * 2, 'the part already on the PC is not sent again');
  assert.deepEqual(pc.files.get('C:\\Users\\me\\setup.exe')?.bytes, contents);

  // The last chunk carried this tab's own checksum of the whole file.
  assert.equal(pc.writes.at(-1)!.fileSha256, hex(contents));
  assert.equal(result.checkedWholeFile, true);
});

test('a resume that would join the wrong bytes is refused before the file is put in place', async () => {
  const contents = randomBytes(MAX_FILE_CHUNK * 2 + 5, 11);
  const pc = new FakePc();
  pc.connectionLeft = 1;

  const record = await interrupted<InterruptedUpload>(
    uploadFile(pc, { file: new Blob([contents]), name: 'a.bin', destination: 'C:\\a.bin', transferId: 't1', ...quiet }),
  );

  // Something else wrote into the part file meanwhile.
  pc.parts.set('C:\\a.bin', randomBytes(MAX_FILE_CHUNK, 99));
  pc.reconnect();

  await assert.rejects(resumeUpload(pc, record, { transferId: 't2', ...quiet }), (error: unknown) => {
    assert.ok(error instanceof FileRefusal);
    assert.equal(error.reason, 'corrupt');
    return true;
  });
  assert.equal(pc.files.has('C:\\a.bin'), false);
});

test('a part file the PC no longer has means starting again, not guessing', async () => {
  const contents = randomBytes(MAX_FILE_CHUNK + 10, 3);
  const pc = new FakePc();
  pc.connectionLeft = 1;

  const record = await interrupted<InterruptedUpload>(
    uploadFile(pc, { file: new Blob([contents]), name: 'b.bin', destination: 'C:\\b.bin', transferId: 't1', ...quiet }),
  );

  // Past the half hour: the PC cleared it.
  pc.parts.clear();
  pc.reconnect();

  const result = await resumeUpload(pc, record, { transferId: 't2', ...quiet });
  assert.equal(result.resumedFrom, 0);
  assert.deepEqual(pc.files.get('C:\\b.bin')?.bytes, contents);
});

test('a file that appeared at the destination meanwhile is not sent over', async () => {
  const pc = new FakePc();
  pc.connectionLeft = 1;

  const record = await interrupted<InterruptedUpload>(
    uploadFile(pc, {
      file: new Blob([randomBytes(MAX_FILE_CHUNK + 1, 5)]),
      name: 'c.bin',
      destination: 'C:\\c.bin',
      transferId: 't1',
      ...quiet,
    }),
  );

  pc.reconnect();
  pc.files.set('C:\\c.bin', { bytes: new Uint8Array([1]), modifiedAt: 'x' });

  await assert.rejects(resumeUpload(pc, record, { transferId: 't2', ...quiet }), (error: unknown) => {
    assert.ok(error instanceof FileRefusal);
    assert.equal(error.reason, 'exists');
    return true;
  });
});

test('pressing Stop removes the part file at once, and a refusal does too', async () => {
  const pc = new FakePc();
  let chunks = 0;

  const stopped = await uploadFile(pc, {
    file: new Blob([randomBytes(MAX_FILE_CHUNK * 3, 1)]),
    name: 'd.bin',
    destination: 'C:\\d.bin',
    transferId: 'stop-me',
    cancelled: () => chunks >= 1,
    onProgress: () => {
      chunks++;
    },
  });

  assert.equal(stopped.outcome, 'stopped');
  assert.deepEqual(pc.cancelled, ['stop-me']);
  assert.equal(pc.parts.has('C:\\d.bin'), false);

  pc.parts.set('C:\\e.bin', new Uint8Array(10));
  await assert.rejects(
    uploadFile(pc, {
      file: new Blob([randomBytes(20, 2)]),
      name: 'e.bin',
      destination: 'C:\\e.bin',
      transferId: 'refused',
      startOffset: 50,
      ...quiet,
    }),
    (error: unknown) => error instanceof FileRefusal && !isInterruption(error),
  );
  assert.ok(pc.cancelled.includes('refused'));
});

test('an upload whose part file was already complete still ends with a checked final chunk', async () => {
  const contents = randomBytes(40, 8);
  const pc = new FakePc();
  pc.parts.set('C:\\f.bin', contents.slice());

  const record: InterruptedUpload = {
    kind: 'upload',
    name: 'f.bin',
    file: new Blob([contents]),
    destination: 'C:\\f.bin',
    done: 40,
  };

  const result = await resumeUpload(pc, record, { transferId: 't', ...quiet });
  assert.equal(result.resumedFrom, 39);
  assert.equal(pc.writes.at(-1)!.final, true);
  assert.deepEqual(pc.files.get('C:\\f.bin')?.bytes, contents);
});

test('a download cut off partway keeps what arrived and fetches only the rest', async () => {
  const contents = randomBytes(MAX_FILE_CHUNK * 3 + 9, 21);
  const pc = new FakePc();
  pc.files.set('C:\\big.iso', { bytes: contents, modifiedAt: '2026-09-01T00:00:00.000Z' });
  pc.connectionLeft = 2;

  const record = await interrupted<InterruptedDownload>(
    downloadFile(pc, { path: 'C:\\big.iso', name: 'big.iso', modifiedAt: '2026-09-01T00:00:00.000Z', ...quiet }),
  );

  assert.equal(record.done, MAX_FILE_CHUNK * 2);
  assert.equal(record.total, contents.length);

  pc.reconnect();
  const offsets: number[] = [];
  const original = pc.readFile.bind(pc);
  pc.readFile = async (path, offset, length) => {
    offsets.push(offset);
    return original(path, offset, length);
  };

  const result = await resumeDownload(pc, record, quiet);
  assert.equal(result.outcome, 'fetched');
  assert.equal(offsets[0], MAX_FILE_CHUNK * 2);

  const joined = new Uint8Array(await new Blob(result.parts as unknown as BlobPart[]).arrayBuffer());
  assert.deepEqual(joined, contents);
});

test('a download is not joined onto a file that changed on the PC meanwhile', async () => {
  const pc = new FakePc();
  pc.files.set('C:\\log.txt', { bytes: randomBytes(MAX_FILE_CHUNK * 2, 4), modifiedAt: '2026-09-01T00:00:00.000Z' });
  pc.connectionLeft = 1;

  const record = await interrupted<InterruptedDownload>(
    downloadFile(pc, { path: 'C:\\log.txt', name: 'log.txt', modifiedAt: '2026-09-01T00:00:00.000Z', ...quiet }),
  );

  pc.reconnect();
  pc.files.set('C:\\log.txt', { bytes: randomBytes(MAX_FILE_CHUNK * 2, 4), modifiedAt: '2026-09-02T00:00:00.000Z' });

  await assert.rejects(resumeDownload(pc, record, quiet), (error: unknown) => {
    assert.ok(error instanceof FileRefusal);
    assert.equal(error.reason, 'changed');
    return true;
  });
});
