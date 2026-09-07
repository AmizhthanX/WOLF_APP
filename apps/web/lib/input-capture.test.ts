import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * Turning what the operator did into what the PC should do.
 *
 * The coordinate cases carry the weight here. A remote desktop rendered with
 * `object-fit: contain` sits inside black bars whenever the aspect ratios differ, and
 * normalising against the element instead of the picture puts every click off — by nothing
 * in the middle of the screen and by a lot near the edges, which is exactly the pattern
 * that gets diagnosed as "input lag" and never as a mapping bug.
 */

class FakeDomRect {
  constructor(
    readonly x: number,
    readonly y: number,
    readonly width: number,
    readonly height: number,
  ) {}

  get left(): number {
    return this.x;
  }

  get top(): number {
    return this.y;
  }
}

const globals = globalThis as unknown as Record<string, unknown>;
globals['DOMRect'] = FakeDomRect;

const { normalizePoint, pictureRect, virtualKeyFor, isExtendedCode, pointerButtonFor, scrollNotches } =
  await import('./input-capture.js');

/** A video element with a given element box and intrinsic picture size. */
function video(
  elementWidth: number,
  elementHeight: number,
  videoWidth: number,
  videoHeight: number,
  left = 0,
  top = 0,
): HTMLVideoElement {
  return {
    videoWidth,
    videoHeight,
    getBoundingClientRect: () => new FakeDomRect(left, top, elementWidth, elementHeight),
  } as unknown as HTMLVideoElement;
}

test('with matching aspect ratios the picture fills the element', () => {
  const rect = pictureRect(video(1600, 900, 1920, 1080));
  assert.ok(rect);
  assert.equal(rect.width, 1600);
  assert.equal(rect.height, 900);
  assert.equal(rect.left, 0);
  assert.equal(rect.top, 0);
});

test('a 16:9 stream in a 4:3 element is letterboxed, and the bars are excluded', () => {
  // 800x600 element showing a 1920x1080 picture: the picture is 800x450, centred, with 75
  // pixels of black above and below.
  const rect = pictureRect(video(800, 600, 1920, 1080));
  assert.ok(rect);
  assert.equal(rect.width, 800);
  assert.equal(rect.height, 450);
  assert.equal(rect.top, 75);
});

test('a click in the middle of the picture is the middle of the remote screen', () => {
  const element = video(800, 600, 1920, 1080);
  const point = normalizePoint(element, 400, 300);

  assert.ok(point);
  assert.equal(point.x, 0.5);
  assert.equal(point.y, 0.5);
});

test('a click in the letterbox is not a click at the edge of the screen', () => {
  const element = video(800, 600, 1920, 1080);

  // 40 pixels down is inside the element and inside the black bar. Treating it as the top
  // edge of the remote desktop would move the pointer somewhere the operator did not aim.
  assert.equal(normalizePoint(element, 400, 40), null);
  assert.equal(normalizePoint(element, 400, 560), null);
});

test('the corners of the picture map to the corners of the remote screen', () => {
  const element = video(800, 600, 1920, 1080);

  const topLeft = normalizePoint(element, 0, 75);
  const bottomRight = normalizePoint(element, 800, 525);

  assert.deepEqual(topLeft, { x: 0, y: 0 });
  assert.deepEqual(bottomRight, { x: 1, y: 1 });
});

test('an element offset in the page does not shift the mapping', () => {
  const element = video(800, 450, 1920, 1080, 120, 64);
  const point = normalizePoint(element, 120 + 400, 64 + 225);

  assert.ok(point);
  assert.equal(point.x, 0.5);
  assert.equal(point.y, 0.5);
});

test('before the first frame there is nothing to map onto', () => {
  // Intrinsic size is zero until a frame arrives. Guessing an aspect ratio here would send
  // the pointer to an arbitrary place for the first few hundred milliseconds.
  assert.equal(pictureRect(video(800, 600, 0, 0)), null);
  assert.equal(normalizePoint(video(800, 600, 0, 0), 400, 300), null);
});

test('keys are mapped from the physical key, not the character it produced', () => {
  // KeyboardEvent.code, so a German keyboard driving a US machine behaves the way the
  // remote user expects rather than the way the local one does.
  assert.equal(virtualKeyFor('KeyA'), 0x41);
  assert.equal(virtualKeyFor('KeyZ'), 0x5a);
  assert.equal(virtualKeyFor('Digit0'), 0x30);
  assert.equal(virtualKeyFor('F1'), 0x70);
  assert.equal(virtualKeyFor('F24'), 0x87);
  assert.equal(virtualKeyFor('Numpad5'), 0x65);
  assert.equal(virtualKeyFor('Enter'), 0x0d);
});

test('left and right modifiers are distinguished', () => {
  // Windows resolves a generic modifier to its left variant, so sending the side-specific
  // code is what lets a right-Alt chord behave as one.
  assert.equal(virtualKeyFor('ControlLeft'), 0xa2);
  assert.equal(virtualKeyFor('ControlRight'), 0xa3);
  assert.equal(virtualKeyFor('AltLeft'), 0xa4);
  assert.equal(virtualKeyFor('AltRight'), 0xa5);

  assert.equal(isExtendedCode('ControlRight'), true);
  assert.equal(isExtendedCode('ControlLeft'), false);
  assert.equal(isExtendedCode('ArrowUp'), true);
});

test('a key with no mapping is not sent at all', () => {
  // An unmapped key is better than a wrong one. Text that has no key sequence — an IME, a
  // phone keyboard — arrives as a text event instead.
  assert.equal(virtualKeyFor('Lang1'), null);
  assert.equal(virtualKeyFor('BrightnessUp'), null);
});

test('mouse buttons map to the protocol names', () => {
  assert.equal(pointerButtonFor(0), 'left');
  assert.equal(pointerButtonFor(1), 'middle');
  assert.equal(pointerButtonFor(2), 'right');
  assert.equal(pointerButtonFor(9), null);
});

test('wheel deltas become notches whatever unit the browser used', () => {
  // deltaMode 0 is pixels (trackpads), 1 is lines (wheels). Sending the raw number would
  // make a trackpad scroll a hundred times further than a mouse.
  const pixels = scrollNotches({ deltaX: 0, deltaY: 100, deltaMode: 0 } as WheelEvent);
  const lines = scrollNotches({ deltaX: 0, deltaY: 3, deltaMode: 1 } as WheelEvent);

  assert.equal(pixels.deltaY, -1);
  assert.equal(lines.deltaY, -1);
});

test('a scroll gesture cannot ask for an unbounded jump', () => {
  const huge = scrollNotches({ deltaX: 0, deltaY: 1_000_000, deltaMode: 1 } as WheelEvent);

  // The protocol caps this at 100 notches, and the host refuses anything beyond it — so
  // clamping here keeps a fast flick from being rejected whole.
  assert.equal(huge.deltaY, -100);
});
