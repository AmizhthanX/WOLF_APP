'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Empty, Panel } from '@/components/ui';
import type { useRemoteDesktop } from '@/lib/use-remote-desktop';
import { MAX_FILE_CHUNK, type FileEntry } from '@/lib/remote-desktop';
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
 */

/** Progress for one transfer, which is all this panel keeps about it. */
interface Progress {
  readonly name: string;
  readonly direction: 'download' | 'upload';
  readonly done: number;
  readonly total: number;
  readonly transferId: string | null;
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

export function FilePanel({ view }: { view: ReturnType<typeof useRemoteDesktop> }) {
  const [folder, setFolder] = useState<string | null>(null);
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);

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

  /* --------------------------------------------------------------------- */
  /* Off the PC                                                             */
  /* --------------------------------------------------------------------- */

  const download = useCallback(
    async (entry: FileEntry) => {
      const path = pathOf(folder, entry);
      cancelled.current = false;
      setNotice(null);
      setProgress({ name: entry.name, direction: 'download', done: 0, total: entry.sizeBytes ?? 0, transferId: null });

      const parts: Uint8Array[] = [];
      let offset = 0;

      try {
        for (;;) {
          if (cancelled.current) return;

          const chunk = await view.readFile(path, offset, MAX_FILE_CHUNK);
          parts.push(chunk.bytes);
          offset += chunk.bytes.length;

          setProgress({
            name: entry.name,
            direction: 'download',
            done: offset,
            total: chunk.totalBytes,
            transferId: null,
          });

          if (chunk.eof) break;

          // A file that never reports the end would otherwise loop forever on a chunk of
          // nothing, which is a browser tab that stops responding rather than an error.
          if (chunk.bytes.length === 0) throw new Error('The PC stopped sending that file.');
        }

        // Assembled here and handed to the browser's own save dialog. It was never uploaded
        // anywhere on the way, and closing this tab is the end of it.
        const blob = new Blob(parts as BlobPart[]);
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = entry.name;
        link.click();
        URL.revokeObjectURL(url);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : 'That file could not be fetched.');
      } finally {
        setProgress(null);
      }
    },
    [folder, view],
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
      const transferId = newId();

      cancelled.current = false;
      setNotice(null);
      setProgress({ name: file.name, direction: 'upload', done: 0, total: file.size, transferId });

      try {
        let offset = 0;

        while (offset < file.size || file.size === 0) {
          if (cancelled.current) {
            await view.cancelTransfer(transferId);
            return;
          }

          const end = Math.min(offset + MAX_FILE_CHUNK, file.size);
          const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
          const final = end >= file.size;

          const written = await view.writeFile({
            transferId,
            path: destination,
            offset,
            bytes,
            final,
            // Never by default. An operator replacing somebody's file should have said so.
            overwrite: false,
            totalBytes: file.size,
          });

          // The PC says where it actually is, which is how a chunk that arrived out of order
          // corrects itself instead of leaving a hole.
          offset = written.bytesWritten;

          setProgress({
            name: file.name,
            direction: 'upload',
            done: offset,
            total: file.size,
            transferId,
          });

          if (written.complete) break;
          if (file.size === 0) break;
        }

        setNotice(`${file.name} was written to the PC.`);
        await browse(folder);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : 'That file could not be sent.');
        await view.cancelTransfer(transferId).catch(() => {});
      } finally {
        setProgress(null);
      }
    },
    [browse, folder, view],
  );

  /* --------------------------------------------------------------------- */

  if (!view.active) {
    return (
      <Panel title="Files">
        <Empty>Browsing this PC&rsquo;s files needs a running stream to it.</Empty>
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
              disabled={folder === null || progress !== null}
            >
              Send a file
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
                      {entry.kind === 'file' ? (
                        <button
                          type="button"
                          onClick={() => void download(entry)}
                          disabled={progress !== null}
                        >
                          Fetch
                        </button>
                      ) : null}
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
