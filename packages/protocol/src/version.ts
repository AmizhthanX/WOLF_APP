/**
 * The wire protocol version.
 *
 * Its own module, with no imports, so code that runs in a browser — the device-proof payload
 * builders — can read it without pulling in the schema library the envelope needs.
 */
export const PROTOCOL_VERSION = 1;
