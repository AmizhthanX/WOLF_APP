'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Empty, Panel } from '@/components/ui';
import type { useRemoteDesktop } from '@/lib/use-remote-desktop';
import type { FileEntry } from '@/lib/remote-desktop';
import {
  downloadFile,
  PARTIAL_UPLOAD_KEPT_MINUTES,
  resumeDownload,
  resumeUpload,
  TransferInterrupted,
  uploadFile,
  type InterruptedTransfer,
} from '@/lib/file-transfer';
import { newId } from '@wolf/shared-types';

/**
 * This PC's disks, from the browser.
 *
 * **Nothing here goes through the cloud** — contents or names. The rule about contents is
 * written down; a directory listing is not innocent either, and a server that never receives
 * one cannot store it. What the cloud knows is that a session was allowed to browse and that
 * a transfer of some size happened.
 *
 * A download is assembled in this tab and handed to the browser's own save dialog. It is
 * never uploaded anywhere on the way, and closing the tab is the end of it.
 *
 * A transfer the connection interrupted can be resumed once this session holds file access
 * again — see `lib/file-transfer.ts`. One stopped with Stop cannot, by design.
 *
 * Rename, move, delete and new folder go the same way, and each is asked about here first. Delete is
 * the Recycle Bin. The PC tells the cloud a change happened, and never what it was called.
 */

/** A change the owner has started to make, waiting for their confirmation or a name. */
type PendingChange =
  | { readonly kind: 'delete'; readonly entry: FileEntry }
  | { readonly kind: 'rename'; readonly entry: FileEntry }
  | { readonly kind: 'move'; readonly entry: FileEntry }
  | { readonly kind: 'create-folder' };

/** Progress for one transfer, which is all this panel keeps about it. */
interface Progress {
  readonly name: string;
  readonly direction: 'download' | 'upload';
  readonly done: number;
  readonly total: number;
}

function readableSize(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** The path of an entry inside the folder currently shown. */
function pathOf(folder: string | null, entry: FileEntry): string {
  if (entry.kind === 'drive') return `${entry.path ?? entry.name}\\`;
  if (folder === null) return entry.name;
  return folder.endsWith('\\') ? folder + entry.name : `${folder}\\${entry.name}`;
}

function parentOf(folder: string): string | null {
  const trimmed = folder.replace(/\\+$/, '');
  const cut = trimmed.lastIndexOf('\\');

  // Above a drive root is the list of drives, which is what null means here.
  if (cut < 0 || cut < trimmed.indexOf(':')) return null;
  return cut === 2 ? `${trimmed.slice(0, 2)}\\` : trimmed.slice(0, cut);
}

/** Hand what arrived to the browser's own save dialog. */
function save(name: string, parts: readonly Uint8Array[]): void {
  // Assembled here. It was never uploaded anywhere on the way, and closing this tab is the
  // end of it.
  const blob = new Blob(parts as unknown as BlobPart[]);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export function FilePanel({ view }: { view: ReturnType<typeof useRemoteDesktop> }) {
  const [folder, setFolder] = useState<string | null>(null);
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [interrupted, setInterrupted] = useState<InterruptedTransfer | null>(null);
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [answer, setAnswer] = useState('');

  const upload = useRef<HTMLInputElement | null>(null);
  const cancelled = useRef(false);

  const control = view.fileControl;
  const holdsLease = control?.granted === true;

  const browse = useCallback(
    async (path: string | null) => {
      setBusy(true);
      setNotice(null);

      try {
        const listing = await view.listFiles(path);
        setFolder(listing.path);
        setEntries([...listing.entries]);
        setTruncated(listing.truncated);
      } catch (error) {
        // The PC's own words. "WOLF will not open that", "Windows refused it" and "there is
        // nothing there" are three different things with three different next steps.
        setNotice(error instanceof Error ? error.message : 'That folder could not be read.');
      } finally {
        setBusy(false);
      }
    },
    [view],
  );

  useEffect(() => {
    if (holdsLease && entries === null) void browse(null);
  }, [holdsLease, entries, browse]);

  /**
   * What every transfer does when it ends early: an interruption is kept for Resume, anything
   * else is the PC's own words.
   */
  const failed = useCallback((error: unknown, fallback: string) => {
    if (error instanceof TransferInterrupted) {
      setInterrupted(error.record);
      setNotice(
        error.record.kind === 'upload'
          ? `${error.message} What reached the PC waits there for ${PARTIAL_UPLOAD_KEPT_MINUTES} minutes; once this session has file access again, resume it.`
          : `${error.message} What arrived is kept in this tab; once this session has file access again, resume it.`,
      );
      return;
    }

    setNotice(error instanceof Error ? error.message : fallback);
  }, []);

  /* --------------------------------------------------------------------- */
  /* Off the PC                                                             */
  /* --------------------------------------------------------------------- */

  const download = useCallback(
    async (entry: FileEntry) => {
      cancelled.current = false;
      setNotice(null);
      setProgress({ name: entry.name, direction: 'download', done: 0, total: entry.sizeBytes ?? 0 });

      try {
        const result = await downloadFile(view, {
          path: pathOf(folder, entry),
          name: entry.name,
          modifiedAt: entry.modifiedAt ?? null,
          cancelled: () => cancelled.current,
          onProgress: (done, total) =>
            setProgress({ name: entry.name, direction: 'download', done, total }),
        });

        if (result.outcome === 'fetched') save(entry.name, result.parts);
      } catch (error) {
        failed(error, 'That file could not be fetched.');
      } finally {
        setProgress(null);
      }
    },
    [failed, folder, view],
  );

  /* --------------------------------------------------------------------- */
  /* Onto the PC                                                            */
  /* --------------------------------------------------------------------- */

  const send = useCallback(
    async (file: File) => {
      if (folder === null) {
        setNotice('Choose a folder on the PC first.');
        return;
      }

      const destination = folder.endsWith('\\') ? folder + file.name : `${folder}\\${file.name}`;

      cancelled.current = false;
      setNotice(null);
      setProgress({ name: file.name, direction: 'upload', done: 0, total: file.size });

      try {
        const result = await uploadFile(view, {
          file,
          name: file.name,
          destination,
          transferId: newId(),
          cancelled: () => cancelled.current,
          onProgress: (done, total) =>
            setProgress({ name: file.name, direction: 'upload', done, total }),
        });

        if (result.outcome === 'written') {
          setNotice(`${file.name} was written to the PC.`);
          await browse(folder);
        }
      } catch (error) {
        failed(error, 'That file could not be sent.');
      } finally {
        setProgress(null);
      }
    },
    [browse, failed, folder, view],
  );

  /* --------------------------------------------------------------------- */
  /* Changing files                                                         */
  /* --------------------------------------------------------------------- */

  const begin = (change: PendingChange) => {
    setNotice(null);
    setPending(change);
    setAnswer(change.kind === 'rename' ? change.entry.name : change.kind === 'move' ? (folder ?? '') : '');
  };

  const change = useCallback(async () => {
    if (!pending || folder === null) return;
    setBusy(true);
    setNotice(null);

    try {
      let said: string;
      switch (pending.kind) {
        case 'delete':
          await view.changeFile({ kind: 'delete', path: pathOf(folder, pending.entry) });
          said = `${pending.entry.name} was moved to the Recycle Bin on the PC, where it can be restored.`;
          break;
        case 'rename':
          await view.changeFile({ kind: 'rename', path: pathOf(folder, pending.entry), newName: answer.trim() });
          said = `${pending.entry.name} was renamed.`;
          break;
        case 'move':
          await view.changeFile({ kind: 'move', path: pathOf(folder, pending.entry), destinationFolder: answer.trim() });
          said = `${pending.entry.name} was moved.`;
          break;
        case 'create-folder':
          await view.changeFile({ kind: 'create-folder', path: folder.endsWith('\\') ? folder + answer.trim() : `${folder}\\${answer.trim()}` });
          said = `The folder ${answer.trim()} was made.`;
          break;
      }
      setPending(null);
      setBusy(false);
      // Listed again first: listing clears the notice, and this one should stay.
      await browse(folder);
      setNotice(said);
    } catch (error) {
      // The PC's own words: taken, in use, not allowed, or a Windows folder WOLF does not change.
      setNotice(error instanceof Error ? error.message : 'That could not be changed.');
      setBusy(false);
    }
  }, [answer, browse, folder, pending, view]);

  /* --------------------------------------------------------------------- */
  /* After an interruption                                                  */
  /* --------------------------------------------------------------------- */

  const resume = useCallback(async () => {
    const record = interrupted;
    if (record === null) return;

    const total = record.kind === 'upload' ? record.file.size : record.total;
    const onProgress = (done: number, of: number) =>
      setProgress({ name: record.name, direction: record.kind, done, total: of });

    cancelled.current = false;
    setInterrupted(null);
    setNotice(null);
    onProgress(record.done, total);

    try {
      if (record.kind === 'download') {
        const result = await resumeDownload(view, record, {
          cancelled: () => cancelled.current,
          onProgress,
        });
        if (result.outcome === 'fetched') save(record.name, result.parts);
        return;
      }

      const result = await resumeUpload(view, record, {
        transferId: newId(),
        cancelled: () => cancelled.current,
        onProgress,
      });

      if (result.outcome === 'written') {
        setNotice(
          result.checkedWholeFile
            ? `${record.name} was written to the PC, and matches the file sent.`
            : // Every chunk was still checked. What is missing is the comparison of the whole,
              // which the browser cannot compute for a file this large without holding all of it.
              `${record.name} was written to the PC. Every part was checked as it arrived, but a file this large is not compared end to end after a resume — check it on the PC before relying on it.`,
        );
        if (folder !== null) await browse(folder);
      }
    } catch (error) {
      failed(error, 'That transfer could not be resumed.');
    } finally {
      setProgress(null);
    }
  }, [browse, failed, folder, interrupted, view]);

  /* --------------------------------------------------------------------- */

  const interruptedPanel =
    interrupted && progress === null ? (
      <div className="notice">
        <strong>
          {interrupted.kind === 'upload' ? 'Sending' : 'Fetching'} {interrupted.name} stopped at{' '}
          {readableSize(interrupted.done)} of{' '}
          {readableSize(interrupted.kind === 'upload' ? interrupted.file.size : interrupted.total)}
        </strong>
        <div style={{ marginTop: 6 }}>
          <button type="button" onClick={() => void resume()} disabled={!holdsLease}>
            Resume
          </button>{' '}
          <button
            type="button"
            onClick={() => {
              // Nothing to tell the PC: the transfer there already ended with the stream, and
              // its part file is removed when its time is up.
              setNotice(
                interrupted.kind === 'upload'
                  ? `The part of ${interrupted.name} already on the PC is removed within ${PARTIAL_UPLOAD_KEPT_MINUTES} minutes.`
                  : null,
              );
              setInterrupted(null);
            }}
          >
            Discard
          </button>
          {!holdsLease ? <span className="muted"> Resuming needs file access to this PC again.</span> : null}
        </div>
      </div>
    ) : null;

  if (!view.active) {
    return (
      <Panel title="Files">
        <div className="stack">
          {notice ? <div className="notice">{notice}</div> : null}
          {interruptedPanel}
          <Empty>Browsing this PC&rsquo;s files needs a running stream to it.</Empty>
        </div>
      </Panel>
    );
  }

  return (
    <Panel
      title="Files"
      actions={
        holdsLease ? (
          <>
            <button type="button" onClick={() => void browse(folder)} disabled={busy}>
              {busy ? 'Reading…' : 'Refresh'}
            </button>
            <button
              type="button"
              onClick={() => upload.current?.click()}
              disabled={folder === null || progress !== null || interrupted !== null}
            >
              Send a file
            </button>
            <button
              type="button"
              onClick={() => begin({ kind: 'create-folder' })}
              disabled={folder === null || busy || progress !== null}
            >
              New folder
            </button>
            <button type="button" onClick={() => view.releaseFiles()}>
              Give up file access
            </button>
          </>
        ) : (
          <button type="button" onClick={() => view.requestFiles()}>
            Ask for file access
          </button>
        )
      }
    >
      <div className="stack">
        {!holdsLease ? (
          <div className="notice">
            <strong>Reaching this PC&rsquo;s files is a separate permission.</strong>
            <div style={{ marginTop: 6 }}>
              {control?.reason === 'capability-missing'
                ? 'This session was not granted access to this PC’s files. Watching a screen is not being handed the disks behind it.'
                : control?.reason === 'held-by-another-session'
                  ? 'Another session is browsing this PC. Two transfers into one destination produce a file that is neither of the things either of them sent.'
                  : 'Ask for access and WOLF will decide whether this session may have it. What you browse and move goes straight between this browser and the PC — no server sees a name or a byte.'}
            </div>
          </div>
        ) : null}

        {notice ? <div className="notice">{notice}</div> : null}

        {interruptedPanel}

        {pending ? (
          <div className="notice">
            <form
              className="stack"
              onSubmit={(event) => {
                event.preventDefault();
                void change();
              }}
            >
              {pending.kind === 'delete' ? (
                <div>
                  <strong>Move {pending.entry.name} to the Recycle Bin?</strong>
                  <div style={{ marginTop: 6 }}>
                    {pending.entry.kind === 'directory' ? 'The folder and everything in it go. ' : ''}
                    It can be restored from the Recycle Bin at the PC. WOLF does not delete anything permanently; if
                    it is too large for the Recycle Bin, Windows asks the person at the PC instead.
                  </div>
                </div>
              ) : (
                <div>
                  <label htmlFor="file-change-answer">
                    {pending.kind === 'rename'
                      ? `New name for ${pending.entry.name}`
                      : pending.kind === 'move'
                        ? `Move ${pending.entry.name} into the folder`
                        : 'Name of the new folder'}
                  </label>
                  <input
                    id="file-change-answer"
                    value={answer}
                    onChange={(event) => setAnswer(event.target.value)}
                    autoFocus
                    required
                  />
                  {pending.kind === 'move' ? (
                    <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                      A folder on the same drive, e.g. C:\Users\you\Documents. Nothing already there is replaced.
                    </div>
                  ) : null}
                </div>
              )}
              <div className="row">
                <button type="submit" className={pending.kind === 'delete' ? 'button-danger' : undefined} disabled={busy}>
                  {pending.kind === 'delete'
                    ? 'Move to Recycle Bin'
                    : pending.kind === 'rename'
                      ? 'Rename'
                      : pending.kind === 'move'
                        ? 'Move'
                        : 'Make folder'}
                </button>
                <button type="button" onClick={() => setPending(null)} disabled={busy}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        ) : null}

        {progress ? (
          <div className="notice">
            <strong>
              {progress.direction === 'download' ? 'Fetching' : 'Sending'} {progress.name}
            </strong>
            <div style={{ marginTop: 6 }}>
              {readableSize(progress.done)}
              {progress.total > 0 ? ` of ${readableSize(progress.total)}` : ''}
              {'  '}
              <button
                type="button"
                onClick={() => {
                  cancelled.current = true;
                }}
              >
                Stop
              </button>
            </div>
          </div>
        ) : null}

        {holdsLease ? (
          <div className="row">
            <button
              type="button"
              onClick={() => void browse(folder === null ? null : parentOf(folder))}
              disabled={folder === null || busy}
            >
              Up
            </button>
            <span className="muted">{folder ?? 'This PC'}</span>
          </div>
        ) : null}

        {truncated ? (
          <div className="notice">
            This folder holds more files than WOLF lists at once. What is below is the first
            part of it, not all of it.
          </div>
        ) : null}

        {holdsLease && entries !== null ? (
          entries.length === 0 ? (
            <Empty>This folder is empty.</Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Size</th>
                  <th>Modified</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.name}>
                    <td>
                      {entry.kind === 'file' ? (
                        <span className={entry.hidden ? 'muted' : undefined}>{entry.name}</span>
                      ) : (
                        <button
                          type="button"
                          className="link"
                          onClick={() => void browse(pathOf(folder, entry))}
                        >
                          {entry.name}
                        </button>
                      )}
                      {/* An operator about to copy a folder should know when it is really a
                          link to somewhere else on the machine. */}
                      {entry.reparse ? <span className="route-badge">link</span> : null}
                      {entry.protectedLocation ? (
                        <span className="route-badge">Windows</span>
                      ) : null}
                    </td>
                    <td>{readableSize(entry.sizeBytes)}</td>
                    <td className="muted">
                      {entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString() : ''}
                    </td>
                    <td>
                      <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
                        {entry.kind === 'file' ? (
                          <button
                            type="button"
                            onClick={() => void download(entry)}
                            disabled={progress !== null || interrupted !== null}
                          >
                            Fetch
                          </button>
                        ) : null}
                        {entry.kind !== 'drive' && !entry.protectedLocation ? (
                          <>
                            <button type="button" onClick={() => begin({ kind: 'rename', entry })} disabled={busy || progress !== null}>
                              Rename
                            </button>
                            <button type="button" onClick={() => begin({ kind: 'move', entry })} disabled={busy || progress !== null}>
                              Move
                            </button>
                            <button
                              type="button"
                              className="button-danger"
                              onClick={() => begin({ kind: 'delete', entry })}
                              disabled={busy || progress !== null}
                            >
                              Delete
                            </button>
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : null}

        <input
          ref={upload}
          type="file"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void send(file);
          }}
        />
      </div>
    </Panel>
  );
}
