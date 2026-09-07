import { z } from 'zod';
import { wolfId } from '@wolf/validation';

/**
 * Remote desktop commands.
 *
 * Starting a stream is not a command — it is a signaling exchange, because SDP and ICE are
 * a conversation rather than a request and a response. What lives here is the surrounding
 * control surface: enumerate what can be captured, and stop what is running.
 */

export const remoteDesktopListDisplaysCommand = z.object({
  type: z.literal('remote-desktop.list-displays'),
  payload: z.object({
    /** Re-enumerate instead of returning the session host's cached layout. */
    refresh: z.boolean().default(false),
  }),
});

export const remoteDesktopStopCommand = z.object({
  type: z.literal('remote-desktop.stop'),
  payload: z.object({
    /** Stop one stream, or every stream on this PC when null. */
    streamId: wolfId.nullable().default(null),
  }),
});

/**
 * Ask the agent whether it can stream at all right now.
 *
 * Separate from `system.capabilities` because the answer changes minute to minute: a
 * locked workstation, a signed-out session, or a session host that has not started yet all
 * make streaming impossible for reasons that resolve on their own.
 */
export const remoteDesktopStatusCommand = z.object({
  type: z.literal('remote-desktop.status'),
  payload: z.object({}),
});

export const remoteDesktopCommand = z.discriminatedUnion('type', [
  remoteDesktopListDisplaysCommand,
  remoteDesktopStopCommand,
  remoteDesktopStatusCommand,
]);

export type RemoteDesktopCommand = z.infer<typeof remoteDesktopCommand>;
