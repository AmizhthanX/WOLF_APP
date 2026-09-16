'use client';

import { useEffect, useRef, useState } from 'react';
import { WolfApiError, type WolfProblem } from '@/lib/client';
import { usePcSession } from '@/lib/use-pc-session';
import { wakeReadiness, wakeSenders, wakeSentText } from '@/lib/wake';
import { listPcs, type Pc } from '@/lib/wolf';
import { ConfirmDialog, Panel, Problem } from '@/components/ui';

/**
 * Wake an offline PC by having another of the owner's PCs broadcast a magic packet on its network.
 *
 * Nothing is opened on the sending PC until the owner presses Wake: choosing a sender from the list is not
 * a reason to start a session on it.
 */
export function WakePanel({ pc }: { pc: Pc }) {
  const [pcs, setPcs] = useState<Pc[] | null>(null);
  const [senderId, setSenderId] = useState<string>('');
  const [waking, setWaking] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<WolfProblem | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listPcs()
      .then((result) => {
        if (!cancelled) setPcs(result.pcs);
      })
      .catch((caught: unknown) => {
        if (!cancelled && caught instanceof WolfApiError) setError(caught.problem);
      });
    return () => {
      cancelled = true;
    };
  }, [pc.status]);

  const readiness = wakeReadiness(pc);
  if (readiness.kind === 'online') return null;

  const senders = pcs ? wakeSenders(pc, pcs) : [];
  const sender = senders.find((candidate) => candidate.id === senderId) ?? null;

  return (
    <Panel title="Wake">
      <div className="stack">
        <p className="secondary" style={{ margin: 0 }}>
          {pc.name} is not connected. Another of your PCs that is online <strong>on the same local network</strong> can
          send it a wake packet. WOLF does not know which of your PCs share a network, so choose one that does.
        </p>

        {readiness.kind === 'switched-off' ? (
          <div className="notice">Remote access to {pc.name} is switched off, so WOLF does not wake it.</div>
        ) : readiness.kind === 'no-address' ? (
          <div className="notice">
            {pc.name} has never reported a wired network adapter, so there is no address to wake it at. Wake-on-LAN needs
            Ethernet; connect it by cable and let WOLF connect from it once.
          </div>
        ) : readiness.kind === 'not-armed' ? (
          <div className="notice">
            The last time {pc.name} connected, Windows had not allowed its wired adapter to wake the PC, so a wake packet
            may do nothing. On {pc.name}, turn on “Allow this device to wake the computer” for the adapter in Device
            Manager, and Wake-on-LAN in its firmware settings.
          </div>
        ) : null}

        {readiness.kind === 'ready' || readiness.kind === 'not-armed' ? (
          pcs === null ? (
            <p className="muted" style={{ margin: 0 }}>Finding your PCs that are online…</p>
          ) : senders.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              None of your other PCs is online with a WOLF version that can send a wake packet.
            </p>
          ) : (
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <label htmlFor="wake-sender" className="muted">
                Send from
              </label>
              <select
                id="wake-sender"
                value={senderId}
                onChange={(event) => setSenderId(event.target.value)}
                disabled={waking !== null}
              >
                <option value="">Choose a PC…</option>
                {senders.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={sender === null || waking !== null}
                onClick={() => {
                  setNotice(null);
                  setError(null);
                  setWaking(senderId);
                }}
              >
                {waking ? 'Sending…' : 'Wake'}
              </button>
            </div>
          )
        ) : null}

        {notice ? <div className="notice">{notice}</div> : null}
        {error ? <Problem problem={error} /> : null}

        {waking && sender ? (
          <WakeSender
            key={waking}
            senderId={sender.id}
            senderName={sender.name}
            target={pc}
            onDone={(outcome) => {
              setWaking(null);
              if (outcome.kind === 'sent') setNotice(outcome.text);
              if (outcome.kind === 'problem') setError(outcome.problem);
            }}
          />
        ) : null}
      </div>
    </Panel>
  );
}

type WakeOutcome =
  | { kind: 'sent'; text: string }
  | { kind: 'problem'; problem: WolfProblem }
  | { kind: 'cancelled' };

const POWER_ONLY = ['power'];

/** A session on the sending PC holding `power` and nothing else, for exactly one wake. */
function WakeSender({
  senderId,
  senderName,
  target,
  onDone,
}: {
  senderId: string;
  senderName: string;
  target: Pc;
  onDone: (outcome: WakeOutcome) => void;
}) {
  const session = usePcSession(senderId, POWER_ONLY);
  const started = useRef(false);

  useEffect(() => {
    if (session.sessionError) onDone({ kind: 'problem', problem: session.sessionError });
  }, [session.sessionError, onDone]);

  useEffect(() => {
    if (!session.sessionToken || started.current) return;
    started.current = true;

    void (async () => {
      try {
        const command = await session.run({
          type: 'power.wake',
          payload: { targetPcId: target.id },
          title: `Wake ${target.name}`,
          description: `${senderName} will broadcast a Wake-on-LAN packet for ${target.name} on its local networks.`,
        });

        if (!command) return onDone({ kind: 'cancelled' });

        const result = command.result as { packetsSent?: number; networks?: number } | null;
        if (command.status === 'completed' && result) {
          return onDone({
            kind: 'sent',
            text: wakeSentText(senderName, target.name, { packetsSent: result.packetsSent ?? 0, networks: result.networks ?? 0 }),
          });
        }

        onDone({
          kind: 'problem',
          problem: {
            code: command.failure?.code ?? 'command.failed',
            problem: `${senderName} did not send the wake packet.`,
            cause: command.failure?.message ?? `The command ended as "${command.status}".`,
            currentState: `${target.name} was not sent a wake packet.`,
            recommendedAction: command.failure?.limitation
              ? `Choose a PC that is connected to the same local network as ${target.name}.`
              : 'Try again, or send it from another PC.',
            referenceId: `WOLF-PWR-${command.id.slice(-4)}`,
            httpStatus: command.failure?.limitation ? 501 : 502,
          },
        });
      } catch (caught) {
        if (caught instanceof WolfApiError) onDone({ kind: 'problem', problem: caught.problem });
        else throw caught;
      }
    })();
  }, [session, senderName, target, onDone]);

  return session.pending ? (
    <ConfirmDialog
      title={session.pending.title}
      description={session.pending.description}
      riskLevel={session.pending.riskLevel}
      requiresPassword={session.pending.requiresPassword}
      busy={session.confirming}
      error={session.confirmError}
      onCancel={session.cancel}
      onConfirm={session.confirm}
    />
  ) : null;
}
