import { z } from 'zod';
import { isoDateTime, wolfId } from '@wolf/validation';

/**
 * Remote input.
 *
 * Input events travel on the WebRTC data channel straight to the session host — not
 * through the cloud, and never as opaque bytes handed to `SendInput`. Everything here is a
 * bounded, typed union, for three reasons:
 *
 *  * A malformed coordinate cannot address something off-screen, because coordinates are
 *    normalised and range-checked before they reach the injection call.
 *  * Keys are virtual-key codes, not strings, so there is no parsing step to get wrong.
 *  * Modifier state is carried explicitly rather than inferred from key history, so a
 *    dropped key-up cannot leave the remote machine with a stuck Ctrl.
 */

/**
 * Pointer position, normalised against the captured display.
 *
 * Normalising means the client never needs to know the remote resolution, and a resolution
 * change mid-stream does not silently start aiming at the wrong pixel.
 */
const normalizedCoordinate = z.number().min(0).max(1);

export const POINTER_BUTTONS = ['left', 'right', 'middle', 'x1', 'x2'] as const;
export const pointerButton = z.enum(POINTER_BUTTONS);
export type PointerButton = z.infer<typeof pointerButton>;

/** Modifier state at the moment the event was produced. */
export const modifierState = z.object({
  shift: z.boolean().default(false),
  control: z.boolean().default(false),
  alt: z.boolean().default(false),
  meta: z.boolean().default(false),
});
export type ModifierState = z.infer<typeof modifierState>;

export const pointerMoveEvent = z.object({
  type: z.literal('pointer.move'),
  x: normalizedCoordinate,
  y: normalizedCoordinate,
  /** Milliseconds since the batch's `sentAt`, so the host can pace a burst of moves. */
  offsetMs: z.number().int().min(0).max(60_000).default(0),
});

export const pointerButtonEvent = z.object({
  type: z.literal('pointer.button'),
  button: pointerButton,
  action: z.enum(['down', 'up']),
  x: normalizedCoordinate,
  y: normalizedCoordinate,
  modifiers: modifierState.default({}),
  offsetMs: z.number().int().min(0).max(60_000).default(0),
});

export const pointerScrollEvent = z.object({
  type: z.literal('pointer.scroll'),
  x: normalizedCoordinate,
  y: normalizedCoordinate,
  /** Wheel deltas in notches. Bounded so one event cannot scroll a document forever. */
  deltaX: z.number().min(-100).max(100),
  deltaY: z.number().min(-100).max(100),
  modifiers: modifierState.default({}),
  offsetMs: z.number().int().min(0).max(60_000).default(0),
});

/**
 * A key, as a Windows virtual-key code.
 *
 * 0 is not a key and 255 is reserved, so the range is 1..254. Sending codes rather than
 * names means there is no lookup table to disagree about between a browser, an Android
 * client, and the agent.
 */
export const virtualKeyCode = z.number().int().min(1).max(254);

export const keyEvent = z.object({
  type: z.literal('key'),
  key: virtualKeyCode,
  action: z.enum(['down', 'up']),
  /**
   * Hardware scan code, when the client knows it. Games and remote-desktop-hostile apps
   * read scan codes directly, so passing one through when available is worth the field.
   */
  scanCode: z.number().int().min(0).max(0xffff).nullable().default(null),
  /** True for keys on the extended set (arrows, right Ctrl/Alt, numpad Enter). */
  extended: z.boolean().default(false),
  modifiers: modifierState.default({}),
  offsetMs: z.number().int().min(0).max(60_000).default(0),
});

/**
 * Literal text, for IME composition and mobile keyboards.
 *
 * Phone keyboards, autocorrect, and IMEs produce characters that have no meaningful
 * key-down sequence, so they are sent as text and injected as Unicode rather than being
 * decomposed into fictional keystrokes.
 */
export const textInputEvent = z.object({
  type: z.literal('text'),
  value: z.string().min(1).max(512),
  offsetMs: z.number().int().min(0).max(60_000).default(0),
});

/**
 * Combinations Windows reserves and a client must not fake.
 *
 * Ctrl+Alt+Del is a Secure Attention Sequence: it is delivered by Winlogon, and a process
 * in the user's session cannot synthesise it no matter how it sends the three keys. Naming
 * it as its own event means the agent can answer "this needs the privileged helper"
 * instead of silently sending three keystrokes that do nothing.
 */
export const SYSTEM_COMBOS = ['ctrl-alt-del', 'win-l', 'win-tab', 'alt-tab', 'print-screen'] as const;
export const systemCombo = z.enum(SYSTEM_COMBOS);
export type SystemCombo = z.infer<typeof systemCombo>;

export const systemComboEvent = z.object({
  type: z.literal('system.combo'),
  combo: systemCombo,
  offsetMs: z.number().int().min(0).max(60_000).default(0),
});

export const inputEvent = z.discriminatedUnion('type', [
  pointerMoveEvent,
  pointerButtonEvent,
  pointerScrollEvent,
  keyEvent,
  textInputEvent,
  systemComboEvent,
]);
export type InputEvent = z.infer<typeof inputEvent>;

/**
 * A batch of input events.
 *
 * Pointer movement arrives far faster than it is worth sending individually, so events are
 * batched per frame. The sequence number lets the host notice a gap; it does not ask for a
 * resend, because stale input is worse than missing input.
 */
export const inputBatch = z.object({
  streamId: wolfId,
  sequence: z.number().int().min(0),
  sentAt: isoDateTime,
  events: z.array(inputEvent).min(1).max(128),
});
export type InputBatch = z.infer<typeof inputBatch>;

/**
 * Host response, sent only when something needs saying.
 *
 * A healthy stream sends nothing back per batch — acknowledging every batch would double
 * the message rate for no benefit.
 */
export const inputResponse = z.object({
  streamId: wolfId,
  /** Sequence this response refers to. */
  sequence: z.number().int().min(0),
  outcome: z.enum(['rejected', 'unsupported', 'not-permitted']),
  reason: z.string().max(200),
  /** True when Windows itself prevents this, rather than WOLF refusing. */
  limitation: z.boolean().default(false),
});
export type InputResponse = z.infer<typeof inputResponse>;

/** Windows virtual-key codes WOLF needs by name. */
export const VirtualKeys = Object.freeze({
  Backspace: 0x08,
  Tab: 0x09,
  Enter: 0x0d,
  Shift: 0x10,
  Control: 0x11,
  Alt: 0x12,
  Pause: 0x13,
  CapsLock: 0x14,
  Escape: 0x1b,
  Space: 0x20,
  PageUp: 0x21,
  PageDown: 0x22,
  End: 0x23,
  Home: 0x24,
  ArrowLeft: 0x25,
  ArrowUp: 0x26,
  ArrowRight: 0x27,
  ArrowDown: 0x28,
  PrintScreen: 0x2c,
  Insert: 0x2d,
  Delete: 0x2e,
  MetaLeft: 0x5b,
  MetaRight: 0x5c,
  F1: 0x70,
  F12: 0x7b,
});

/** Keys that must be sent with the extended flag for Windows to interpret them correctly. */
const EXTENDED_KEYS = new Set<number>([
  VirtualKeys.Insert,
  VirtualKeys.Delete,
  VirtualKeys.Home,
  VirtualKeys.End,
  VirtualKeys.PageUp,
  VirtualKeys.PageDown,
  VirtualKeys.ArrowLeft,
  VirtualKeys.ArrowUp,
  VirtualKeys.ArrowRight,
  VirtualKeys.ArrowDown,
  VirtualKeys.MetaLeft,
  VirtualKeys.MetaRight,
  VirtualKeys.PrintScreen,
]);

export function isExtendedKey(key: number): boolean {
  return EXTENDED_KEYS.has(key);
}
