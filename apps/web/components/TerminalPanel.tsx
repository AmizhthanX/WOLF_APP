'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Empty, Panel } from '@/components/ui';
import type { useRemoteDesktop } from '@/lib/use-remote-desktop';
import type { TerminalShell } from '@/lib/remote-desktop';
import { keyToTerminal, TerminalScreen, type TerminalLine } from '@/lib/terminal-render';

/**
 * A shell on the PC.
 *
 * The one part of WOLF that is arbitrary command execution, and the UI says so rather than
 * presenting it as another panel. It is its own capability, its own lease, and — visibly —
 * its own deliberate act: nothing here starts until the operator asks for it.
 *
 * **What is typed and printed here never reaches the cloud.** It goes straight between this
 * browser and the PC on the WebRTC data channel, for the same reason clipboard content does
 * and a stronger one: terminal output routinely carries secrets nobody meant to disclose.
 * The renderer below holds the scrollback and nothing else does — no state, no storage, no
 * log. Closing the panel is the end of it.
 */

const SHELLS: { id: TerminalShell; label: string }[] = [
  { id: 'cmd', label: 'Command Prompt' },
  { id: 'powershell', label: 'Windows PowerShell' },
  { id: 'pwsh', label: 'PowerShell 7' },
];

/**
 * The size the PC is told the terminal is.
 *
 * Fixed rather than measured, for now. A shell wraps its own output to this width, so it has
 * to be a number both ends agree on; measuring the rendered element and resizing on every
 * layout change is a refinement, not a correctness matter.
 */
const COLUMNS = 120;
const ROWS = 30;

/** The sixteen ANSI colours, as a terminal on Windows renders them. */
const PALETTE = [
  '#0c0c0c', '#c50f1f', '#13a10e', '#c19c00', '#0037da', '#881798', '#3a96dd', '#cccccc',
  '#767676', '#e74856', '#16c60c', '#f9f1a5', '#3b78ff', '#b4009e', '#61d6d6', '#f2f2f2',
];

export function TerminalPanel({ view }: { view: ReturnType<typeof useRemoteDesktop> }) {
  const screen = useMemo(() => new TerminalScreen(), []);
  const [lines, setLines] = useState<TerminalLine[]>([]);
  const [terminalId, setTerminalId] = useState<string | null>(null);
  const [shell, setShell] = useState<TerminalShell>('cmd');
  const [notice, setNotice] = useState<string | null>(null);
  const [exited, setExited] = useState(false);
  const [partial, setPartial] = useState(false);

  const surface = useRef<HTMLDivElement | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const openId = useRef<string | null>(null);

  const control = view.terminalControl;
  const holdsLease = control?.granted === true;
  const running = terminalId !== null && !exited;

  useEffect(() => {
    openId.current = terminalId;
  }, [terminalId]);

  /* --------------------------------------------------------------------- */
  /* What the PC says                                                       */
  /* --------------------------------------------------------------------- */

  useEffect(
    () =>
      view.onTerminalEvent((event) => {
        switch (event.kind) {
          case 'opened':
            // The id came back from the PC, so a refusal for one terminal cannot be read as
            // the answer for another.
            setTerminalId(event.terminalId);
            setExited(false);
            setNotice(null);
            return;

          case 'output': {
            if (event.terminalId !== openId.current) return;

            screen.write(event.data ?? '');
            setLines(screen.snapshot());
            setPartial(screen.usedUnsupportedSequences);
            return;
          }

          case 'exited':
            if (event.terminalId !== openId.current) return;
            setExited(true);
            setNotice(event.detail);
            return;

          case 'refused':
            setNotice(event.detail);
            return;
        }
      }),
    [screen, view],
  );

  // Follow the output, the way a terminal does. Only when the operator is already at the
  // bottom: yanking the view back while they are reading something further up is the most
  // annoying thing a log view can do.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;

    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 60;
    if (atBottom) element.scrollTop = element.scrollHeight;
  }, [lines]);

  /* --------------------------------------------------------------------- */
  /* What the operator does                                                 */
  /* --------------------------------------------------------------------- */

  const open = useCallback(() => {
    screen.clear();
    setLines([]);
    setPartial(false);
    setExited(false);
    setNotice(null);

    const id = view.openTerminal(shell, COLUMNS, ROWS);
    if (id === null) setNotice('WOLF is not ready to open a shell on this PC yet.');
  }, [screen, shell, view]);

  const close = useCallback(() => {
    if (terminalId) view.closeTerminal(terminalId);
    setTerminalId(null);
    setExited(false);
  }, [terminalId, view]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!running || !terminalId) return;

      // Left alone deliberately: the operator's own copy, paste and reload still work, and a
      // terminal that swallowed Ctrl+Shift+C would be worse than one that misses a keystroke.
      if (event.ctrlKey && event.shiftKey) return;
      if (event.metaKey) return;

      const data = keyToTerminal(event);
      if (data === null) return;

      event.preventDefault();
      view.sendTerminalInput(terminalId, data);
    },
    [running, terminalId, view],
  );

  const onPaste = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      if (!running || !terminalId) return;

      const text = event.clipboardData.getData('text');
      if (!text) return;

      event.preventDefault();

      // Newlines become carriage returns, because that is what a shell reads as "run it".
      // Pasted verbatim they would arrive as blank lines and the command would never run.
      view.sendTerminalInput(terminalId, text.replace(/\r?\n/g, '\r'));
    },
    [running, terminalId, view],
  );

  /* --------------------------------------------------------------------- */

  if (!view.active) {
    return (
      <Panel title="Terminal">
        <Empty>A terminal needs a running stream to this PC.</Empty>
      </Panel>
    );
  }

  return (
    <Panel
      title="Terminal"
      actions={
        holdsLease ? (
          <>
            {running ? (
              <button type="button" onClick={close}>
                Close shell
              </button>
            ) : (
              <button type="button" onClick={open}>
                Open shell
              </button>
            )}
            <button type="button" onClick={() => view.releaseTerminal()}>
              Give up the terminal
            </button>
          </>
        ) : (
          <button type="button" onClick={() => view.requestTerminal()}>
            Ask for a terminal
          </button>
        )
      }
    >
      <div className="stack">
        {!holdsLease ? (
          <div className="notice">
            <strong>Running commands is a separate permission.</strong>
            <div style={{ marginTop: 6 }}>
              {control?.reason === 'capability-missing'
                ? 'This session was not granted a terminal on this PC. Watching a screen and running commands on the machine behind it are different things, and one does not imply the other.'
                : control?.reason === 'held-by-another-session'
                  ? 'Another session is holding the terminal on this PC. Two people typing into one shell produce a command neither of them wrote.'
                  : 'Ask for the terminal and WOLF will decide whether this session may have one. Everything typed here goes straight to the PC and is never stored by WOLF.'}
            </div>
          </div>
        ) : null}

        {holdsLease && !running ? (
          <div className="row">
            <label htmlFor="wolf-shell">Shell</label>
            <select
              id="wolf-shell"
              value={shell}
              onChange={(event) => setShell(event.target.value as TerminalShell)}
            >
              {SHELLS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {notice ? <div className="notice">{notice}</div> : null}

        {partial ? (
          <div className="notice">
            <strong>This output is not being shown exactly as the PC drew it.</strong>
            <div style={{ marginTop: 6 }}>
              Something running in this shell paints a full screen — an editor, a pager, a
              progress display that redraws in place. WOLF shows terminal output as
              scrollback and has no screen to paint onto, so what is below is incomplete
              rather than wrong in a way you would notice.
            </div>
          </div>
        ) : null}

        {terminalId ? (
          <div
            ref={scroller}
            className="terminal-scroll"
            onClick={() => surface.current?.focus()}
          >
            <div
              ref={surface}
              className="terminal-surface"
              tabIndex={0}
              role="textbox"
              aria-label="Remote terminal"
              aria-multiline="true"
              onKeyDown={onKeyDown}
              onPaste={onPaste}
            >
              {lines.map((line, index) => (
                <div key={index} className="terminal-line">
                  {line.spans.length === 0 ? (
                    ' '
                  ) : (
                    line.spans.map((span, spanIndex) => (
                      <span
                        key={spanIndex}
                        style={{
                          color:
                            span.color === null
                              ? undefined
                              : PALETTE[span.inverse ? (span.background ?? 0) : span.color],
                          background:
                            span.background === null
                              ? undefined
                              : PALETTE[span.inverse ? (span.color ?? 15) : span.background],
                          fontWeight: span.bold ? 600 : undefined,
                          textDecoration: span.underline ? 'underline' : undefined,
                        }}
                      >
                        {span.text}
                      </span>
                    ))
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : holdsLease ? (
          <Empty>No shell is open. Choose one and open it.</Empty>
        ) : null}

        {running ? (
          <div className="muted">
            Click the output to type into it. What you type goes straight to the PC on the
            encrypted connection — WOLF never sees it, stores it, or writes it to a log.
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
