'use client';

/**
 * Turning browser events into WOLF input events.
 *
 * Two translations happen here, and both are places where a plausible-looking shortcut is
 * wrong:
 *
 *  * **Coordinates.** The video is rendered with `object-fit: contain`, so the picture does
 *    not fill the element — there are bars above and below, or left and right, whenever the
 *    aspect ratios differ. Normalising against the element's own rectangle would put every
 *    click off by the size of those bars, increasingly so towards the edges.
 *  * **Keys.** `KeyboardEvent.key` is the character produced, which depends on the *local*
 *    keyboard layout; `KeyboardEvent.code` is the physical key, which does not. The remote
 *    machine applies its own layout to a virtual-key code, so sending the physical key is
 *    what makes a German keyboard driving a US machine behave the way the remote user
 *    expects rather than the way the local one does.
 */

export interface NormalizedPoint {
  x: number;
  y: number;
}

/**
 * Where the picture actually is inside the element.
 *
 * Returns null before the first frame, when the intrinsic size is still zero and there is
 * nothing sensible to map onto.
 */
export function pictureRect(video: HTMLVideoElement): DOMRect | null {
  const element = video.getBoundingClientRect();
  const width = video.videoWidth;
  const height = video.videoHeight;

  if (width === 0 || height === 0 || element.width === 0 || element.height === 0) return null;

  const scale = Math.min(element.width / width, element.height / height);
  const displayedWidth = width * scale;
  const displayedHeight = height * scale;

  return new DOMRect(
    element.left + (element.width - displayedWidth) / 2,
    element.top + (element.height - displayedHeight) / 2,
    displayedWidth,
    displayedHeight,
  );
}

/**
 * Normalise a viewport point against the streamed picture.
 *
 * Null when the point is in the letterbox rather than on the remote desktop — a click on a
 * black bar is not a click at the edge of the screen, and treating it as one would move the
 * remote pointer somewhere the operator did not aim.
 */
export function normalizePoint(
  video: HTMLVideoElement,
  clientX: number,
  clientY: number,
): NormalizedPoint | null {
  const rect = pictureRect(video);
  if (!rect) return null;

  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;

  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

/**
 * Physical key to Windows virtual-key code.
 *
 * Built from `KeyboardEvent.code`, so it describes which key was pressed rather than what
 * it produced. Anything not in this table is not sent: an unmapped key is better than a
 * wrong one, and text that has no key sequence arrives through the `text` event instead.
 */
const VIRTUAL_KEYS: Record<string, number> = {
  Backspace: 0x08,
  Tab: 0x09,
  Enter: 0x0d,
  ShiftLeft: 0xa0,
  ShiftRight: 0xa1,
  ControlLeft: 0xa2,
  ControlRight: 0xa3,
  AltLeft: 0xa4,
  AltRight: 0xa5,
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
  ContextMenu: 0x5d,
  NumpadMultiply: 0x6a,
  NumpadAdd: 0x6b,
  NumpadSubtract: 0x6d,
  NumpadDecimal: 0x6e,
  NumpadDivide: 0x6f,
  NumpadEnter: 0x0d,
  NumLock: 0x90,
  ScrollLock: 0x91,
  Semicolon: 0xba,
  Equal: 0xbb,
  Comma: 0xbc,
  Minus: 0xbd,
  Period: 0xbe,
  Slash: 0xbf,
  Backquote: 0xc0,
  BracketLeft: 0xdb,
  Backslash: 0xdc,
  BracketRight: 0xdd,
  Quote: 0xde,
  IntlBackslash: 0xe2,
};

for (let index = 0; index < 26; index++) {
  VIRTUAL_KEYS[`Key${String.fromCharCode(65 + index)}`] = 0x41 + index;
}

for (let digit = 0; digit <= 9; digit++) {
  VIRTUAL_KEYS[`Digit${digit}`] = 0x30 + digit;
  VIRTUAL_KEYS[`Numpad${digit}`] = 0x60 + digit;
}

// F1 through F24. The higher ones exist in the virtual-key table whether or not a keyboard
// has them, and a remote machine may well be driven by one that does.
for (let index = 1; index <= 24; index++) {
  VIRTUAL_KEYS[`F${index}`] = 0x6f + index;
}

/** Keys Windows expects with the extended flag set. */
const EXTENDED_CODES = new Set([
  'Insert',
  'Delete',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowLeft',
  'ArrowUp',
  'ArrowRight',
  'ArrowDown',
  'NumpadDivide',
  'NumpadEnter',
  'MetaLeft',
  'MetaRight',
  'ControlRight',
  'AltRight',
  'PrintScreen',
]);

export function virtualKeyFor(code: string): number | null {
  return VIRTUAL_KEYS[code] ?? null;
}

export function isExtendedCode(code: string): boolean {
  return EXTENDED_CODES.has(code);
}

/** Browser mouse button number to the protocol's name. */
export function pointerButtonFor(button: number): 'left' | 'right' | 'middle' | 'x1' | 'x2' | null {
  switch (button) {
    case 0:
      return 'left';
    case 1:
      return 'middle';
    case 2:
      return 'right';
    case 3:
      return 'x1';
    case 4:
      return 'x2';
    default:
      return null;
  }
}

/**
 * Wheel deltas in notches, whatever units the browser used.
 *
 * `deltaMode` is pixels on most trackpads, lines on most wheels, and pages on a few. Sending
 * the raw number would make a trackpad scroll a hundred times further than a mouse.
 */
export function scrollNotches(event: WheelEvent): { deltaX: number; deltaY: number } {
  const scale = event.deltaMode === 1 ? 1 / 3 : event.deltaMode === 2 ? 1 : 1 / 100;

  const clamp = (value: number) => Math.max(-100, Math.min(100, value * scale));

  // Inverted: a browser reports scrolling down as a positive delta, and Windows reports it
  // as a negative wheel movement.
  return { deltaX: clamp(event.deltaX), deltaY: clamp(-event.deltaY) };
}
