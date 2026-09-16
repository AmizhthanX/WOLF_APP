import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/**
 * Where a webhook may send a request: public addresses on the internet, and nowhere a cloud server's own
 * network could be reached through.
 *
 * Refused, by range:
 *
 * | IPv4 | Why |
 * | --- | --- |
 * | 0.0.0.0/8, 127.0.0.0/8 | "this host" and loopback |
 * | 10/8, 172.16/12, 192.168/16 | private networks |
 * | 100.64.0.0/10 | carrier-grade NAT, and some cloud providers' internal ranges |
 * | 169.254.0.0/16 | link-local — where cloud metadata services answer |
 * | 192.0.0.0/24, 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 | protocol assignments and documentation |
 * | 192.88.99.0/24, 198.18.0.0/15 | 6to4 relay, benchmarking |
 * | 224.0.0.0/4, 240.0.0.0/4 | multicast, reserved and broadcast |
 *
 * | IPv6 | Why |
 * | --- | --- |
 * | ::, ::1 | unspecified and loopback |
 * | ::ffff:0:0/96, ::/96 | IPv4-mapped and -compatible: an IPv4 address in disguise |
 * | 64:ff9b::/96, 64:ff9b:1::/48 | NAT64: the same |
 * | 100::/64 | discard |
 * | 2001::/32, 2002::/16 | Teredo and 6to4 tunnels, which carry IPv4 to wherever they point |
 * | 2001:db8::/32 | documentation |
 * | fc00::/7, fe80::/10 | unique-local and link-local |
 * | ff00::/8 | multicast |
 *
 * An IPv4-mapped address is refused outright rather than unwrapped and judged: there is no reason a webhook
 * receiver's DNS should answer with one.
 *
 * Two lists, not one: a single `BlockList` also matches an IPv4 address against IPv6 rules for IPv4-mapped
 * space, which blocks every IPv4 address once `::ffff:0:0/96` is on it. Found by the test for a public address.
 */
const BLOCKED_V4 = (() => {
  const list = new BlockList();
  const v4: [string, number][] = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ];
  for (const [network, prefix] of v4) list.addSubnet(network, prefix, 'ipv4');
  return list;
})();

const BLOCKED_V6 = (() => {
  const list = new BlockList();
  const v6: [string, number][] = [
    ['::', 128],
    ['::1', 128],
    ['::', 96],
    ['::ffff:0:0', 96],
    ['64:ff9b::', 96],
    ['64:ff9b:1::', 48],
    ['100::', 64],
    ['2001::', 32],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
  ];
  for (const [network, prefix] of v6) list.addSubnet(network, prefix, 'ipv6');
  return list;
})();

/** Names that are local by definition, refused before anything is resolved. */
const LOCAL_NAMES = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home\.arpa|corp)$/i;

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  // A dotted IPv4 inside an IPv6 literal is matched by the IPv6 ranges above.
  return family === 4 ? !BLOCKED_V4.check(address, 'ipv4') : !BLOCKED_V6.check(address, 'ipv6');
}

export type EgressVerdict =
  | { readonly ok: true; readonly hostname: string; readonly address: string; readonly family: 4 | 6; readonly port: number }
  | { readonly ok: false; readonly reason: 'not-https' | 'local-name' | 'not-resolved' | 'not-public'; readonly detail: string };

export type Resolver = (hostname: string) => Promise<readonly { address: string; family: number }[]>;

export const systemResolver: Resolver = (hostname) => lookup(hostname, { all: true, verbatim: true });

/**
 * Check a webhook URL and choose the address to connect to.
 *
 * Every address the name resolves to has to be public, not just the first: a name answering with one public
 * and one private address is refused, because a client that picks the other one reaches the inside.
 */
export async function checkEgress(rawUrl: string, resolve: Resolver = systemResolver): Promise<EgressVerdict> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'not-https', detail: 'That is not a URL.' };
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    return { ok: false, reason: 'not-https', detail: 'A webhook must be an https URL with no user name or password.' };
  }

  // URL keeps the brackets on an IPv6 literal.
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const port = url.port ? Number(url.port) : 443;

  if (isIP(hostname) === 0 && (LOCAL_NAMES.test(hostname) || !hostname.includes('.'))) {
    return { ok: false, reason: 'local-name', detail: `${hostname} is a name for something on a local network, not the internet.` };
  }

  let addresses: readonly { address: string; family: number }[];
  if (isIP(hostname) !== 0) {
    addresses = [{ address: hostname, family: isIP(hostname) }];
  } else {
    try {
      addresses = await resolve(hostname);
    } catch {
      return { ok: false, reason: 'not-resolved', detail: `${hostname} could not be found.` };
    }
  }

  if (addresses.length === 0) {
    return { ok: false, reason: 'not-resolved', detail: `${hostname} could not be found.` };
  }

  if (addresses.some((entry) => !isPublicAddress(entry.address))) {
    return {
      ok: false,
      reason: 'not-public',
      detail: `${hostname} points at a private, local or reserved address. WOLF sends webhooks only to the public internet.`,
    };
  }

  const chosen = addresses[0]!;
  return { ok: true, hostname, address: chosen.address, family: chosen.family === 6 ? 6 : 4, port };
}
