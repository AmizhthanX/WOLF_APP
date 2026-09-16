# Wake-on-LAN

A PC that is asleep has no connection to WOLF and cannot hear a command. So a wake is sent to **another of
the owner's PCs that is online**, and that PC broadcasts a magic packet on its own local networks. The PC
being woken shows as online when its agent connects again — which is the only confirmation there is.

```
owner ──power.wake {targetPcId}──▶ API ──adds the target's address──▶ online PC ──UDP broadcast, port 9──▶ sleeping PC
```

## What a PC reports about being woken

At every connection the agent's capabilities include two things (`WakeAdapter`), both read without
administrator:

- **`wakeMacAddress`** — the hardware address of its wired adapter. From `MSFT_NetAdapter`: a hardware
  interface, not virtual, on 802.3. Hyper-V switches, VPN adapters and Bluetooth are left out, and so is
  Wi-Fi: almost no wireless adapter keeps its radio listening while its PC sleeps, and offering it would be
  offering something that does not work.
- **`wakeOnLanCapable`** — whether Windows has armed that adapter to wake the PC: the list `powercfg
  /devicequery wake_armed` prints, asked of `powrprof.dll` directly rather than by running powercfg.

What cannot be read without administrator, and so is never claimed: the firmware's own wake setting, and the
adapter's "wake on magic packet" property. **Armed is not "will wake"**, and the dashboard and the app say
so.

A finding while building this: the filter constant for "wake enabled" is `0x08000000`, not `0x8`, and the
filters are ORed, not ANDed with a capability mask. The first version reported this machine's adapter as not
armed while powercfg listed it; the combination in use was checked against powercfg on a real machine.

## Where the address lives

The address is stored on the PC's row (`pcs.wake_mac_address`) when the agent reports one, and **kept** when a
later report has none — a laptop on Wi-Fi today is still woken at the adapter it has.

It is **never returned to a client**. The API tells clients `wakeAddressKnown`, and nothing more; an
end-to-end test checks the address does not appear in the PC's JSON or in the audit trail, which names the
target by PC id. It is not a secret — anybody on the LAN can read it — but it identifies a physical machine,
and no client needs it.

## Sending one

`power.wake` is **medium** risk under the `power` capability, so it is confirmed like any other medium action.
A client sends `{ targetPcId }`. The API, before anything is queued (`CommandService.resolveWake`):

- the target must be one of the caller's PCs, not revoked — otherwise 404;
- not the sending PC — a PC cannot wake itself (409);
- not switched off with the kill switch — a PC somebody locked out of remote access is not woken remotely;
- not already online (409);
- with a known address (409, `pc.wake_address_unknown`, saying to connect it by Ethernet once).

Then the address the target reported is put into the payload. **A `macAddress` a client sends is replaced,
never used**, so no client can point a PC at a machine WOLF does not know. Each refusal is audited as denied.

`power.wake` is not automatable. It could be; it is not on the list because nothing in the automation editor
chooses a sending PC, and an automation that silently picked one would be deciding something the owner has
not.

## On the sending PC

`WakeCommandHandler` refuses an address that is not one adapter's (a group or all-zero address), and one that
belongs to this PC. Then, for each IPv4 network the PC is on, it sends the fixed 102-byte packet — six `0xFF`
bytes and the address sixteen times — to UDP port 9:

- at the network's broadcast address, from a socket bound to this PC's address on that network, so it leaves
  on that adapter; and at `255.255.255.255` from the same address, because some switches forward one kind of
  broadcast and not the other;
- three times, 200 ms apart, because some adapters miss the first packet while settling into sleep.

**Which networks:** up, not loopback, not a tunnel; not link-local (a PC that got no address is not on a
network another PC is on); prefixes /8 to /30 only — a /31 or /32 has no broadcast address, and a network
wider than /8 is not a LAN. Never a unicast destination, never another port. The operator chooses none of it.

The result is what happened and no more: `packetsSent`, `networks`, `method: "lan-broadcast"`, and
`confirmationPending: true`. No packets accepted by Windows is a failure (`wake-send-failed`, likely a
firewall); no usable network is a limitation (`no-local-network`). The log line has counts, never an address.

## Choosing the sender

WOLF never learns which PCs share a network: nothing reports a subnet or a gateway to the cloud, and it is
not worth starting to for this. So the owner chooses. The web dashboard's Power tab on an offline PC, and the
Android PC screen, list the owner's other PCs that are online, not switched off, and whose agent supports
`power.wake`, and say the sender has to be on the same local network. Nothing is opened on a sender until the
owner presses Wake; then a session holding `power` and nothing else is opened on it for that one wake, and
ended when it is done.

## Proven

- Agent: the packet's shape; addresses refused; the networks chosen from a mixed list; a wake to two networks
  sending twelve packets, all to broadcast addresses on port 9; refusals sending nothing; the real UDP sender
  putting the packet on the wire; this PC's wired adapter read without administrator and reported armed,
  matching powercfg.
- API: the address filled in, a client's replaced, every refusal before anything is queued and audited,
  confirmation still required.
- End to end through the real HTTP app and relay: a PC reports its adapter and disconnects, is shown as
  `wakeAddressKnown` without the address, and is woken through another at exactly the reported address.
- **Live**, the local cloud and the real agent on the development PC: a stand-in PC enrolled, reported an
  address and went offline; the real agent was asked to wake it — refused without confirmation, refused to
  wake itself, then sent six packets on its one network — and a UDP listener on port 9 on the same machine
  received all six, byte for byte.

**Not proven:** a real sleeping PC waking. There is one PC here. Whether a given machine wakes depends on its
firmware and adapter settings, which WOLF cannot read or change.

## Not built

- Waking across the internet. A broadcast does not leave its network, and directed broadcasts through a
  router are off almost everywhere, correctly. An always-on device on the LAN — the `relay` method the
  protocol names — would do it, and is not built.
- Changing a PC's wake settings. The adapter property and the firmware both need administrator or a reboot
  into setup; WOLF says what to change instead.
