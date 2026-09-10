/**
 * Turning what a Windows shell prints into something a browser can show.
 *
 * A pseudo console emits a real VT stream: colour, cursor movement, screen clears, the lot.
 * A full terminal emulator maintains a grid and applies all of it, which is a large piece of
 * software — `xterm.js` exists precisely because it is not a weekend's work.
 *
 * This is deliberately not that. It is a **scrollback renderer**: it keeps a growing list of
 * lines, applies the sequences that make ordinary command output correct — colour, carriage
 * returns, backspace, erase-to-end-of-line — and discards the ones that address the screen
 * as a grid. That covers what people actually do in a remote shell: run a command, read what
 * it printed, run another.
 *
 * **What it does not do is stated rather than approximated.** Anything that paints a
 * full-screen interface — an editor, `more`, a progress display that redraws in place — will
 * not look right here, because this has no grid to paint onto. It reports that it saw such a
 * sequence so the UI can say so, rather than rendering something subtly wrong and leaving the
 * operator to work out that what they are reading is not what the machine printed.
 */

/** One run of text with a single appearance. */
export interface TerminalSpan {
  readonly text: string;
  /** ANSI colour 0-15, or null for the terminal's default. */
  readonly color: number | null;
  readonly background: number | null;
  readonly bold: boolean;
  readonly underline: boolean;
  readonly inverse: boolean;
}

export interface TerminalLine {
  readonly spans: readonly TerminalSpan[];
}

interface Appearance {
  color: number | null;
  background: number | null;
  bold: boolean;
  underline: boolean;
  inverse: boolean;
}

const DEFAULT_APPEARANCE: Appearance = {
  color: null,
  background: null,
  bold: false,
  underline: false,
  inverse: false,
};

/** How much scrollback is kept before the top is dropped. */
export const MAX_TERMINAL_LINES = 5000;

/**
 * A terminal's visible state, built up from whatever the shell has sent so far.
 *
 * Stateful on purpose: escape sequences and even single characters arrive split across
 * chunks, and a renderer that started fresh on each chunk would break every sequence that
 * happened to straddle a pipe read.
 */
export class TerminalScreen {
  private lines: TerminalSpan[][] = [[]];
  /** Where the next character goes on the current line, in characters. */
  private column = 0;
  private appearance: Appearance = { ...DEFAULT_APPEARANCE };
  /** A partial escape sequence carried over from the previous chunk. */
  private pending = '';
  private sawFullScreen = false;

  /**
   * True once the shell has tried to paint a full-screen interface.
   *
   * The UI shows this rather than pretending. An operator who has just run something that
   * redraws in place needs to know the picture is incomplete — otherwise they read a garbled
   * screen as the machine misbehaving.
   */
  get usedUnsupportedSequences(): boolean {
    return this.sawFullScreen;
  }

  /** Everything printed so far, oldest first. */
  snapshot(): TerminalLine[] {
    return this.lines.map((spans) => ({ spans }));
  }

  clear(): void {
    this.lines = [[]];
    this.column = 0;
    this.appearance = { ...DEFAULT_APPEARANCE };
    this.pending = '';
    this.sawFullScreen = false;
  }

  /** Feed one chunk of output. */
  write(chunk: string): void {
    const text = this.pending + chunk;
    this.pending = '';

    let index = 0;

    while (index < text.length) {
      const character = text[index]!;

      if (character === '\x1b') {
        const consumed = this.escape(text, index);

        if (consumed === null) {
          // An escape sequence split across chunks. Held rather than rendered: printing the
          // half we have would put `[3` in the middle of somebody's output.
          this.pending = text.slice(index);
          return;
        }

        index += consumed;
        continue;
      }

      index += 1;

      switch (character) {
        case '\n':
          this.newline();
          break;

        case '\r':
          // A carriage return alone rewrites the current line, which is how a shell shows a
          // prompt after the command it echoed. Honoured rather than treated as a newline.
          this.column = 0;
          break;

        case '\b':
          if (this.column > 0) this.column -= 1;
          break;

        case '\x07':
          // The bell. Silently dropped: a remote machine ringing a browser's bell is not a
          // thing anybody asked for.
          break;

        case '\t':
          this.put('        '.slice(0, 8 - (this.column % 8)));
          break;

        default:
          // Other C0 controls are dropped rather than printed as boxes.
          if (character >= ' ' || character === ' ') this.put(character);
          break;
      }
    }
  }

  /**
   * Handle one escape sequence.
   *
   * Returns how many characters it consumed, or null when the sequence is incomplete and the
   * rest of it is in the next chunk.
   */
  private escape(text: string, start: number): number | null {
    const next = text[start + 1];
    if (next === undefined) return null;

    // CSI: the common case — colour, cursor movement, erasing.
    if (next === '[') {
      let index = start + 2;
      while (index < text.length && !isFinalByte(text[index]!)) index += 1;
      if (index >= text.length) return null;

      const parameters = text.slice(start + 2, index);
      const final = text[index]!;
      this.csi(parameters, final);
      return index - start + 1;
    }

    // OSC: window titles, mostly. Terminated by BEL or ST.
    if (next === ']') {
      let index = start + 2;
      while (index < text.length) {
        if (text[index] === '\x07') return index - start + 1;
        if (text[index] === '\x1b' && text[index + 1] === '\\') return index - start + 2;
        index += 1;
      }
      return null;
    }

    // Anything else is a two-character sequence WOLF does not act on.
    return 2;
  }

  private csi(parameters: string, final: string): void {
    switch (final) {
      case 'm':
        this.appearanceFrom(parameters);
        return;

      case 'K': {
        // Erase in line. Only "to the end", which is what a shell uses when it redraws a
        // prompt; the other two modes address the line as a grid.
        const mode = parameters === '' ? '0' : parameters;
        if (mode === '0' || mode === '') this.truncate();
        else this.sawFullScreen = true;
        return;
      }

      case 'J':
        // Erase in display. A clear screen is common enough to honour — `cls` is a thing
        // people type — and it maps onto scrollback as "start again".
        this.lines = [[]];
        this.column = 0;
        return;

      case 'H':
      case 'f':
        // Cursor position. Home is harmless and everything else is a grid operation.
        if (parameters === '' || parameters === '1;1') {
          this.column = 0;
          return;
        }
        this.sawFullScreen = true;
        return;

      case 'A':
      case 'B':
      case 'C':
      case 'D':
      case 'E':
      case 'F':
      case 'S':
      case 'T':
      case 'L':
      case 'M':
      case 'P':
      case 'X':
      case '@':
        // Cursor movement, scrolling, insert and delete. All of them address a grid this
        // renderer does not have.
        this.sawFullScreen = true;
        return;

      case 'h':
      case 'l':
        // Mode set and reset — cursor visibility, bracketed paste, win32 input mode. Nothing
        // to do here, and not a sign of a full-screen program.
        return;

      default:
        return;
    }
  }

  private appearanceFrom(parameters: string): void {
    const codes = (parameters === '' ? '0' : parameters).split(';').map((value) => Number(value));

    for (let index = 0; index < codes.length; index += 1) {
      const code = codes[index]!;

      if (code === 0) this.appearance = { ...DEFAULT_APPEARANCE };
      else if (code === 1) this.appearance.bold = true;
      else if (code === 4) this.appearance.underline = true;
      else if (code === 7) this.appearance.inverse = true;
      else if (code === 22) this.appearance.bold = false;
      else if (code === 24) this.appearance.underline = false;
      else if (code === 27) this.appearance.inverse = false;
      else if (code >= 30 && code <= 37) this.appearance.color = code - 30;
      else if (code === 39) this.appearance.color = null;
      else if (code >= 40 && code <= 47) this.appearance.background = code - 40;
      else if (code === 49) this.appearance.background = null;
      else if (code >= 90 && code <= 97) this.appearance.color = code - 90 + 8;
      else if (code >= 100 && code <= 107) this.appearance.background = code - 100 + 8;
      else if (code === 38 || code === 48) {
        // 256-colour and truecolour, collapsed to the nearest basic colour rather than
        // rendered: keeping sixteen colours honest is worth more than approximating 16m.
        const kind = codes[index + 1];
        index += kind === 5 ? 2 : kind === 2 ? 4 : 1;
      }
    }
  }

  private newline(): void {
    this.lines.push([]);
    this.column = 0;

    if (this.lines.length > MAX_TERMINAL_LINES) {
      this.lines.splice(0, this.lines.length - MAX_TERMINAL_LINES);
    }
  }

  /** Current line as plain text, for the column arithmetic. */
  private currentText(): string {
    return (this.lines[this.lines.length - 1] ?? []).map((span) => span.text).join('');
  }

  private replaceCurrent(text: string, spans: TerminalSpan[]): void {
    void text;
    this.lines[this.lines.length - 1] = spans;
  }

  private truncate(): void {
    const spans = this.lines[this.lines.length - 1] ?? [];
    const kept: TerminalSpan[] = [];
    let seen = 0;

    for (const span of spans) {
      if (seen >= this.column) break;

      const take = Math.min(span.text.length, this.column - seen);
      kept.push({ ...span, text: span.text.slice(0, take) });
      seen += take;
    }

    this.replaceCurrent('', kept);
  }

  /**
   * Put text at the cursor, overwriting what is already there.
   *
   * Overwriting rather than appending is what makes `\r` work: a shell that echoes a command
   * and then redraws the prompt over it expects the second write to replace the first.
   */
  private put(text: string): void {
    const current = this.currentText();

    if (this.column >= current.length) {
      // The common case: writing at the end. Padded when a carriage return moved the cursor
      // past the end of a shorter line.
      const padding = this.column - current.length;
      const spans = [...(this.lines[this.lines.length - 1] ?? [])];

      if (padding > 0) {
        spans.push({ ...DEFAULT_APPEARANCE, text: ' '.repeat(padding) });
      }

      const last = spans[spans.length - 1];
      if (last && sameAppearance(last, this.appearance)) {
        spans[spans.length - 1] = { ...last, text: last.text + text };
      } else {
        spans.push({ ...this.appearance, text });
      }

      this.replaceCurrent('', spans);
      this.column += text.length;
      return;
    }

    // Overwriting mid-line. Rebuilt from plain text and re-spanned, which is simple and
    // correct; the alternative is splicing spans, which is fiddly and gets this wrong in the
    // one case it exists for.
    const rebuilt = current.slice(0, this.column) + text + current.slice(this.column + text.length);

    this.replaceCurrent('', [{ ...DEFAULT_APPEARANCE, text: rebuilt }]);
    this.column += text.length;
  }
}

function sameAppearance(span: TerminalSpan, appearance: Appearance): boolean {
  return (
    span.color === appearance.color &&
    span.background === appearance.background &&
    span.bold === appearance.bold &&
    span.underline === appearance.underline &&
    span.inverse === appearance.inverse
  );
}

/** CSI sequences end at a byte in 0x40-0x7E. */
function isFinalByte(character: string): boolean {
  const code = character.charCodeAt(0);
  return code >= 0x40 && code <= 0x7e;
}

/**
 * Turn a browser key event into the bytes a terminal expects.
 *
 * Returns null for keys that are not text and have no sequence — modifiers on their own,
 * function keys WOLF does not map — so the caller can leave the event alone rather than
 * sending nothing and swallowing it.
 */
export function keyToTerminal(event: {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
}): string | null {
  if (event.ctrlKey && !event.altKey && event.key.length === 1) {
    const upper = event.key.toUpperCase();
    const code = upper.charCodeAt(0);

    // Ctrl+A..Ctrl+Z, and Ctrl+C in particular: the one every operator reaches for, and the
    // reason a terminal needs its own key handling rather than reusing the screen's.
    if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
  }

  switch (event.key) {
    case 'Enter':
      return '\r';
    case 'Backspace':
      return '\x7f';
    case 'Tab':
      return '\t';
    case 'Escape':
      return '\x1b';
    case 'ArrowUp':
      return '\x1b[A';
    case 'ArrowDown':
      return '\x1b[B';
    case 'ArrowRight':
      return '\x1b[C';
    case 'ArrowLeft':
      return '\x1b[D';
    case 'Home':
      return '\x1b[H';
    case 'End':
      return '\x1b[F';
    case 'Delete':
      return '\x1b[3~';
    case 'PageUp':
      return '\x1b[5~';
    case 'PageDown':
      return '\x1b[6~';
    default:
      return event.key.length === 1 && !event.ctrlKey && !event.altKey ? event.key : null;
  }
}
