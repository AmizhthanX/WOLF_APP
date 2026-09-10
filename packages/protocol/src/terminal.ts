import { z } from 'zod';
import { wolfId } from '@wolf/validation';

/**
 * A shell on the PC, driven from the browser.
 *
 * This is the one feature in WOLF that is arbitrary command execution, and it is built as
 * its own thing for exactly that reason. Everything else the agent does is a typed,
 * allow-listed operation — terminate *this* pid, disable *that* device — because a narrow
 * surface is what stops a bug in the network-facing process becoming anything at all. A
 * terminal has no such surface by definition, so instead of pretending otherwise it gets:
 *
 *  - **its own capability.** `terminal` is granted per session and separately from
 *    everything else. Seeing the screen, driving the mouse and running commands are three
 *    different intrusions, and holding one never implies another.
 *  - **its own exclusive lease.** Two operators typing into one shell produce a command
 *    neither of them wrote. `terminal` is arbitrated by the cloud like keyboard control.
 *  - **a separate capability again for elevation.** `terminal-admin` is not built yet, and
 *    a non-elevated session cannot become one by asking nicely.
 *
 * ## Where the bytes go
 *
 * On the WebRTC data channel, never through the cloud — the same path as input and the
 * clipboard, for a reason that is stronger here than for either. Terminal output routinely
 * contains secrets nobody meant to disclose: a connection string echoed by a script, a token
 * in an environment dump, a password typed into a prompt that was not hiding it. Content
 * that never reaches a server cannot be retained by one, logged by one, or subpoenaed from
 * one. The cloud decides *who may open a terminal* and records that it happened; it never
 * sees a byte of what was typed or printed.
 *
 * The cost of that choice is stated rather than hidden: the data channel belongs to a
 * stream, so a terminal needs a running stream. Opening a shell on a PC nobody is watching
 * would need a second channel, which is a different feature.
 */

/**
 * Shells WOLF will start, as names rather than paths.
 *
 * The agent maps each of these to a fixed executable it resolves itself. A caller-supplied
 * path would make the allow-list decorative: "run this program as the signed-in user" is a
 * different and much larger thing than "give me a shell".
 */
export const TERMINAL_SHELLS = ['cmd', 'powershell', 'pwsh'] as const;
export const terminalShell = z.enum(TERMINAL_SHELLS);
export type TerminalShell = z.infer<typeof terminalShell>;

/**
 * The largest chunk of terminal traffic WOLF will carry in one message.
 *
 * Generous for typing and modest for output: a `dir /s` of a large tree produces megabytes,
 * and it arrives as many of these rather than one enormous one. The cap exists so a peer
 * that has gone wrong cannot make the far end allocate without bound.
 */
export const MAX_TERMINAL_CHUNK = 64 * 1024;

/** How many shells one stream may hold open at once. */
export const MAX_TERMINALS_PER_STREAM = 4;

/**
 * Terminal geometry.
 *
 * Bounded because it reaches `CreatePseudoConsole` as a console size, and because a shell
 * told it has four billion columns wraps its output in ways nobody can read.
 */
export const terminalColumns = z.number().int().min(20).max(500);
export const terminalRows = z.number().int().min(5).max(200);

/** Open a shell. Sent by the client, on the data channel. */
export const terminalOpen = z.object({
  kind: z.literal('terminal.open'),
  streamId: wolfId,
  /** Chosen by the client so it can match the answer to the request it made. */
  terminalId: wolfId,
  shell: terminalShell,
  columns: terminalColumns,
  rows: terminalRows,
  /**
   * Where the shell starts.
   *
   * A directory, not a command. Absent means the user's profile directory, which is where a
   * shell opened by hand would start.
   */
  workingDirectory: z.string().max(4096).nullable().default(null),
});

/** Keystrokes for a running shell. Text, as the terminal would receive it. */
export const terminalInput = z.object({
  kind: z.literal('terminal.input'),
  terminalId: wolfId,
  data: z.string().max(MAX_TERMINAL_CHUNK),
});

/** The viewer resized. The shell is told, so its own line wrapping matches. */
export const terminalResize = z.object({
  kind: z.literal('terminal.resize'),
  terminalId: wolfId,
  columns: terminalColumns,
  rows: terminalRows,
});

/** End a shell. The process is terminated with its children. */
export const terminalClose = z.object({
  kind: z.literal('terminal.close'),
  terminalId: wolfId,
});

/** The shell started, and this is what it turned out to be. */
export const terminalOpened = z.object({
  kind: z.literal('terminal.opened'),
  terminalId: wolfId,
  shell: terminalShell,
  /**
   * The shell's process id on the PC.
   *
   * Surfaced so an operator can find it in the process list, and so an audit trail on the
   * machine itself lines up with one in WOLF.
   */
  processId: z.number().int().min(0),
  columns: terminalColumns,
  rows: terminalRows,
  /** Whether this shell is running elevated. Always false until `terminal-admin` exists. */
  elevated: z.boolean().default(false),
});

/**
 * Output from the shell.
 *
 * Carries whatever the console wrote, escape sequences included, because a terminal that
 * strips them shows a shell nobody recognises. The sequence number is there so a client can
 * notice a gap rather than render a corrupted screen as if it were fine.
 */
export const terminalOutput = z.object({
  kind: z.literal('terminal.output'),
  terminalId: wolfId,
  sequence: z.number().int().min(0),
  data: z.string().max(MAX_TERMINAL_CHUNK),
});

/** The shell ended, on its own or because it was asked to. */
export const terminalExited = z.object({
  kind: z.literal('terminal.exited'),
  terminalId: wolfId,
  /** Null when the process was terminated rather than exiting by itself. */
  exitCode: z.number().int().nullable().default(null),
  reason: z.enum(['exited', 'closed', 'stream-ended', 'failed']),
});

/**
 * Why something about a terminal did not happen.
 *
 * Always answered, never dropped. An operator who types into a shell that is not there
 * needs to know whether they were refused, whether it had already exited, or whether the
 * PC could not start one at all.
 */
export const terminalRefused = z.object({
  kind: z.literal('terminal.refused'),
  terminalId: wolfId,
  reason: z.enum([
    /** This session was not granted the terminal capability, or does not hold the lease. */
    'not-permitted',
    /** Elevation was asked for and `terminal-admin` is not built. */
    'unsupported',
    /** No terminal with this id is open on this stream. */
    'unknown-terminal',
    /** The stream already holds as many shells as it may. */
    'too-many',
    /** The PC could not start the shell — it is not installed, or the launch failed. */
    'unavailable',
    /** The message was outside the bounds the protocol allows. */
    'rejected',
  ]),
  detail: z.string().max(200),
  /**
   * True when this is Windows saying no rather than WOLF.
   *
   * The distinction is the one the whole product is built on: "WOLF refused this" and "this
   * machine cannot do that" call for different responses from the person reading it.
   */
  limitation: z.boolean().default(false),
});

/** Everything a client may send about terminals. */
export const terminalClientMessage = z.discriminatedUnion('kind', [
  terminalOpen,
  terminalInput,
  terminalResize,
  terminalClose,
]);
export type TerminalClientMessage = z.infer<typeof terminalClientMessage>;

/** Everything a PC may send about terminals. */
export const terminalAgentMessage = z.discriminatedUnion('kind', [
  terminalOpened,
  terminalOutput,
  terminalExited,
  terminalRefused,
]);
export type TerminalAgentMessage = z.infer<typeof terminalAgentMessage>;

export type TerminalOpen = z.infer<typeof terminalOpen>;
export type TerminalOutput = z.infer<typeof terminalOutput>;
export type TerminalRefused = z.infer<typeof terminalRefused>;
