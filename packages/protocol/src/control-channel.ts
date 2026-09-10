import { z } from 'zod';
import { isoDateTime, wolfId } from '@wolf/validation';
import { inputBatch, inputResponse } from './input.js';
import {
  fileCancel,
  fileChunk,
  fileInfo,
  fileList,
  fileListing,
  fileRead,
  fileRefused,
  fileStat,
  fileWrite,
  fileWritten,
} from './files.js';
import {
  terminalClose,
  terminalExited,
  terminalInput,
  terminalOpen,
  terminalOpened,
  terminalOutput,
  terminalRefused,
  terminalResize,
} from './terminal.js';

/**
 * What travels on the WebRTC data channel.
 *
 * This is the one path in WOLF that does not pass through the cloud. Input, clipboard,
 * terminal and file traffic go straight between the browser and the session host, for two
 * different reasons: input because a round trip through a server would add latency to every
 * keystroke, and the rest because **WOLF must never store what they carry**. Content that
 * never reaches the cloud cannot be retained by it, accidentally logged by it, or subpoenaed
 * from it.
 *
 * Files are here for contents *and* names. The rule about contents is written down; a
 * directory listing is not innocent either — `Divorce settlement.docx` is a fact about
 * somebody whether or not the file is ever opened.
 *
 * Everything here is discriminated on `kind`. The channel carries more than one sort of
 * message, and telling them apart by which fields happen to be present is the kind of
 * guess that turns a malformed clipboard message into a stream of injected keystrokes.
 */

export const controlInput = z.object({
  kind: z.literal('input'),
  batch: inputBatch,
});

export const controlInputResponse = z.object({
  kind: z.literal('input.response'),
  response: inputResponse,
});

/**
 * The largest clipboard payload WOLF will carry.
 *
 * 256 KB is a very large paste — a long log, a whole source file — and well beyond what
 * anybody moves between machines by hand. Past it the content is refused with a stated
 * reason rather than truncated, because a silently shortened paste is worse than one that
 * did not happen: the operator does not find out until whatever they pasted is broken.
 */
export const MAX_CLIPBOARD_TEXT = 256 * 1024;

/**
 * Clipboard content moving in either direction.
 *
 * Text only. Images and files are deliberately excluded: they are a different feature with
 * different rules — WOLF must not persist transferred files either — and quietly carrying a
 * 40 MB bitmap because somebody pressed Ctrl+C on a screenshot is not something to do by
 * accident.
 */
export const clipboardContent = z.object({
  kind: z.literal('clipboard.content'),
  streamId: wolfId,
  format: z.literal('text'),
  text: z.string().max(MAX_CLIPBOARD_TEXT),
  /** Which machine the content came from, so the receiving side can label it. */
  origin: z.enum(['pc', 'client']),
  at: isoDateTime,
});

/**
 * Why clipboard content was not carried.
 *
 * Always answered, never dropped silently. An operator who copies something and finds
 * nothing on the other machine needs to know whether it was too big, not permitted, or
 * simply a format WOLF does not move.
 */
export const clipboardRefused = z.object({
  kind: z.literal('clipboard.refused'),
  streamId: wolfId,
  reason: z.enum([
    'not-permitted',
    'too-large',
    'unsupported-format',
    'unavailable',
    'failed',
  ]),
  detail: z.string().max(200),
});

/** Sent when the PC's clipboard holds something WOLF will not move, so the UI can say so. */
export const clipboardUnsupported = z.object({
  kind: z.literal('clipboard.unsupported'),
  streamId: wolfId,
  /** e.g. "image", "files". Never the content itself. */
  describes: z.string().max(64),
});

export const controlMessage = z.discriminatedUnion('kind', [
  controlInput,
  controlInputResponse,
  clipboardContent,
  clipboardRefused,
  clipboardUnsupported,
  terminalOpen,
  terminalInput,
  terminalResize,
  terminalClose,
  terminalOpened,
  terminalOutput,
  terminalExited,
  terminalRefused,
  fileList,
  fileStat,
  fileRead,
  fileWrite,
  fileCancel,
  fileListing,
  fileInfo,
  fileChunk,
  fileWritten,
  fileRefused,
]);
export type ControlMessage = z.infer<typeof controlMessage>;
export type ClipboardContent = z.infer<typeof clipboardContent>;
