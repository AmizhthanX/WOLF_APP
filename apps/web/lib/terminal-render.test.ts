import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyToTerminal, MAX_TERMINAL_LINES, TerminalScreen } from './terminal-render.js';

/**
 * Reading what a Windows shell printed.
 *
 * The renderer is deliberately not a terminal emulator — it keeps scrollback and applies the
 * sequences that make ordinary command output correct. These tests are mostly about the
 * boundary between those two: what it renders faithfully, and what it *reports* it cannot
 * render rather than approximating.
 */

const ESC = '\x1b';

function text(screen: TerminalScreen): string {
  return screen
    .snapshot()
    .map((line) => line.spans.map((span) => span.text).join(''))
    .join('\n');
}

test('plain output arrives as plain lines', () => {
  const screen = new TerminalScreen();
  screen.write('Microsoft Windows [Version 10.0]\r\n(c) Microsoft Corporation.\r\n');

  assert.equal(text(screen), 'Microsoft Windows [Version 10.0]\n(c) Microsoft Corporation.\n');
});

test('a carriage return rewrites the line rather than starting a new one', () => {
  const screen = new TerminalScreen();

  // How a shell shows a prompt after echoing what was typed, and how progress output
  // redraws itself. Treating it as a newline turns one line into dozens.
  screen.write('working...\rdone      ');

  assert.equal(text(screen), 'done      ');
});

test('backspace removes what it should', () => {
  const screen = new TerminalScreen();
  screen.write('dirr\b \b');

  // What the shell echoes when somebody mistypes and corrects it. Rendering the backspace as
  // a character would show `dirr` with a box after it.
  assert.equal(text(screen), 'dir ');
});

test('colour is kept, because a shell without it is a different shell', () => {
  const screen = new TerminalScreen();
  screen.write(`${ESC}[31merror${ESC}[0m: not found`);

  const spans = screen.snapshot()[0]!.spans;

  assert.equal(spans[0]!.text, 'error');
  assert.equal(spans[0]!.color, 1);
  assert.equal(spans[1]!.text, ': not found');
  assert.equal(spans[1]!.color, null);
});

test('bright colours and attributes are understood', () => {
  const screen = new TerminalScreen();
  screen.write(`${ESC}[1;92mPS${ESC}[m>`);

  const spans = screen.snapshot()[0]!.spans;
  assert.equal(spans[0]!.color, 10);
  assert.equal(spans[0]!.bold, true);
  assert.equal(spans[1]!.bold, false);
});

test('an escape sequence split across two chunks is not printed as text', () => {
  const screen = new TerminalScreen();

  // Output arrives in whatever sizes the pipe produced. A renderer that reset per chunk
  // would put `[31` in the middle of somebody's output every time a sequence straddled one.
  screen.write(`red: ${ESC}[3`);
  screen.write('1mvalue');

  assert.equal(text(screen), 'red: value');
  assert.equal(screen.snapshot()[0]!.spans.at(-1)!.color, 1);
});

test('erase-to-end-of-line truncates rather than being printed', () => {
  const screen = new TerminalScreen();
  screen.write(`a long line of output\r${ESC}[Kshort`);

  assert.equal(text(screen), 'short');
});

test('clearing the screen starts the scrollback again', () => {
  const screen = new TerminalScreen();
  screen.write('old output\r\n');
  screen.write(`${ESC}[2J${ESC}[Hfresh`);

  // `cls` is a thing people type. Mapping it onto scrollback as "start again" is the honest
  // equivalent, and leaving the old text above it would be the confusing alternative.
  assert.equal(text(screen), 'fresh');
});

test('window titles are swallowed, not shown', () => {
  const screen = new TerminalScreen();
  screen.write(`${ESC}]0;C:\\Windows\\system32\\cmd.exe\x07C:\\>`);

  // conhost sets the title constantly. Rendered as text it would put a path in front of
  // every prompt.
  assert.equal(text(screen), 'C:\\>');
});

test('a full-screen program is reported rather than approximated', () => {
  const screen = new TerminalScreen();
  assert.equal(screen.usedUnsupportedSequences, false);

  screen.write('normal output\r\n');
  assert.equal(screen.usedUnsupportedSequences, false);

  // Cursor addressing. This renderer has no grid to paint onto, and something that paints
  // one is exactly what it cannot show — so it says so instead of rendering a garbled screen
  // and leaving the operator to conclude the machine is broken.
  screen.write(`${ESC}[10;5HX`);
  assert.equal(screen.usedUnsupportedSequences, true);
});

test('cursor visibility and mode changes are not mistaken for full-screen painting', () => {
  const screen = new TerminalScreen();

  // conhost sends these constantly — win32 input mode, focus events, cursor hide and show.
  // Counting them as full-screen painting would put a warning above every session.
  screen.write(`${ESC}[?9001h${ESC}[?1004h${ESC}[?25lhello${ESC}[?25h`);

  assert.equal(text(screen), 'hello');
  assert.equal(screen.usedUnsupportedSequences, false);
});

test('scrollback is bounded so a runaway command cannot exhaust the tab', () => {
  const screen = new TerminalScreen();
  screen.write('x\r\n'.repeat(MAX_TERMINAL_LINES + 500));

  assert.ok(screen.snapshot().length <= MAX_TERMINAL_LINES);
});

test('the bell is dropped', () => {
  const screen = new TerminalScreen();
  screen.write('done\x07');

  // A remote machine ringing a browser's bell is not something anybody asked for.
  assert.equal(text(screen), 'done');
});

test('control keys reach the shell as the bytes it expects', () => {
  // The one every operator reaches for, and the reason a terminal needs its own key handling
  // rather than reusing the screen's: Ctrl+C on a remote shell must interrupt the command,
  // not copy anything.
  assert.equal(keyToTerminal({ key: 'c', ctrlKey: true, altKey: false }), '\x03');
  assert.equal(keyToTerminal({ key: 'd', ctrlKey: true, altKey: false }), '\x04');

  assert.equal(keyToTerminal({ key: 'Enter', ctrlKey: false, altKey: false }), '\r');
  assert.equal(keyToTerminal({ key: 'Backspace', ctrlKey: false, altKey: false }), '\x7f');
  assert.equal(keyToTerminal({ key: 'ArrowUp', ctrlKey: false, altKey: false }), `${ESC}[A`);
  assert.equal(keyToTerminal({ key: 'a', ctrlKey: false, altKey: false }), 'a');
});

test('keys with no meaning to a terminal are left alone', () => {
  // Returning an empty string would swallow the browser's own handling of them; null lets
  // the caller decide, which for F5 means "reload the page" and not "send nothing".
  assert.equal(keyToTerminal({ key: 'Shift', ctrlKey: false, altKey: false }), null);
  assert.equal(keyToTerminal({ key: 'F5', ctrlKey: false, altKey: false }), null);
  assert.equal(keyToTerminal({ key: 'Control', ctrlKey: true, altKey: false }), null);
});
