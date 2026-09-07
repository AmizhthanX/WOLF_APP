/** Transport route actually carrying a session. LAN is always preferred, relay is last. */
export const CONNECTION_ROUTES = ['lan', 'p2p', 'relay'] as const;
export type ConnectionRoute = (typeof CONNECTION_ROUTES)[number];

/** Ordered by preference; index 0 is the most preferred route. */
export const ROUTE_PREFERENCE: readonly ConnectionRoute[] = CONNECTION_ROUTES;

/** Lifecycle of any WOLF connection (client -> cloud, client -> PC, agent -> cloud). */
export const CONNECTION_STATES = [
  'CONNECTING',
  'AUTHENTICATING',
  'CONNECTED_LAN',
  'CONNECTED_P2P',
  'CONNECTED_RELAY',
  'RECONNECTING',
  'SYNCING',
  'DISCONNECTED',
] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

/** Remote desktop stream state, including the Windows session boundaries we cannot fake. */
export const REMOTE_DESKTOP_STATES = [
  'STARTING',
  'STREAMING',
  'DEGRADED',
  'RECONNECTING',
  'LOCKED',
  'LOGIN',
  'RESTARTING',
  'OFFLINE',
] as const;
export type RemoteDesktopState = (typeof REMOTE_DESKTOP_STATES)[number];

/** Windows session state reported by the agent. Never inferred optimistically. */
export const WINDOWS_SESSION_STATES = [
  'desktop',
  'locked',
  'login',
  'restarting',
  'offline',
  'unknown',
] as const;
export type WindowsSessionState = (typeof WINDOWS_SESSION_STATES)[number];

export function connectionStateForRoute(route: ConnectionRoute): ConnectionState {
  switch (route) {
    case 'lan':
      return 'CONNECTED_LAN';
    case 'p2p':
      return 'CONNECTED_P2P';
    case 'relay':
      return 'CONNECTED_RELAY';
  }
}

export function isConnectedState(state: ConnectionState): boolean {
  return state === 'CONNECTED_LAN' || state === 'CONNECTED_P2P' || state === 'CONNECTED_RELAY';
}
