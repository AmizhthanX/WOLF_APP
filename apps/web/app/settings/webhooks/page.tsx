'use client';

import { useCallback, useEffect, useState } from 'react';
import { WolfApiError, type WolfProblem } from '@/lib/client';
import {
  createWebhook,
  deleteWebhook,
  listWebhooks,
  rotateWebhookSecret,
  testWebhook,
  updateWebhook,
  type AlertSeverity,
  type Webhook,
  type WebhookFormat,
} from '@/lib/wolf';
import { FORMAT_LABELS, outcomeText, stateText, suggestFormat } from '@/lib/webhooks';
import { AppShell } from '@/components/AppShell';
import { Empty, Panel, Problem } from '@/components/ui';
import { useAuthority } from '@/components/use-authority';

export default function WebhooksPage() {
  return (
    <AppShell>
      <Webhooks />
    </AppShell>
  );
}

const SEVERITIES: { id: AlertSeverity; label: string }[] = [
  { id: 'info', label: 'Everything' },
  { id: 'warning', label: 'Warnings and critical' },
  { id: 'critical', label: 'Critical only' },
];

const TONE: Record<'ok' | 'warn' | 'off', string> = {
  ok: 'status status-online',
  warn: 'status status-warn',
  off: 'status status-offline',
};

function Webhooks() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [limit, setLimit] = useState(10);
  const [error, setError] = useState<WolfProblem | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [minSeverity, setMinSeverity] = useState<AlertSeverity>('warning');
  const [format, setFormat] = useState<WebhookFormat>('wolf');

  const { attempt, dialog } = useAuthority(setError);

  const load = useCallback(async () => {
    try {
      const result = await listWebhooks();
      setConfigured(result.configured);
      setWebhooks(result.webhooks);
      setLimit(result.limit);
    } catch (caught) {
      if (caught instanceof WolfApiError) setError(caught.problem);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (id: string, work: () => Promise<void>) => {
    setBusy(id);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (caught) {
      if (caught instanceof WolfApiError) setError(caught.problem);
      else throw caught;
    } finally {
      setBusy(null);
    }
  };

  const add = () =>
    attempt(
      'Add a webhook',
      async () => {
        const created = await createWebhook({ name: name.trim(), url: url.trim(), format, minSeverity });
        setSecret({ name: created.webhook.name, value: created.secret });
        setName('');
        setUrl('');
        await load();
      },
      'From now on WOLF will send your notifications to this address, whether or not anybody is watching.',
    );

  const rotate = (webhook: Webhook) =>
    attempt(
      `Replace the signing secret for “${webhook.name}”`,
      async () => {
        const rotated = await rotateWebhookSecret(webhook.id);
        setSecret({ name: webhook.name, value: rotated.secret });
      },
      'The old secret stops working at once. Update the receiver with the new one.',
    );

  return (
    <div className="stack">
      <div>
        <h1>Webhooks</h1>
        <p className="secondary" style={{ marginTop: 4 }}>
          Send your notifications to a chat channel or your own service as they happen. Each request is signed, so
          the receiver can check it came from WOLF.
        </p>
      </div>

      {error ? <Problem problem={error} /> : null}
      {notice ? <div className="notice">{notice}</div> : null}
      {dialog}

      {secret ? (
        <div className="notice">
          <strong>Signing secret for “{secret.name}”</strong>
          <div style={{ marginTop: 6 }}>
            <code style={{ userSelect: 'all', wordBreak: 'break-all' }}>{secret.value}</code>
          </div>
          <div className="muted" style={{ marginTop: 6 }}>
            Shown this once. WOLF does not store it; replacing it is the only way to see a secret again.
            Each request carries <code>WOLF-Signature: t=…,v1=…</code>, an HMAC-SHA256 of the timestamp, a dot and
            the body.
          </div>
          <button type="button" onClick={() => setSecret(null)} style={{ marginTop: 6 }}>
            I have saved it
          </button>
        </div>
      ) : null}

      {configured === false ? (
        <div className="notice">
          Webhooks are not set up on this WOLF server: it needs a webhook key (<code>WOLF_WEBHOOK_KEY</code>) to keep
          their addresses encrypted and to sign what it sends. Notifications still arrive in the app.
        </div>
      ) : null}

      {configured ? (
        <Panel title="Add a webhook">
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              void act('create', add);
            }}
          >
            <div>
              <label htmlFor="webhook-name">Name</label>
              <input id="webhook-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required />
            </div>
            <div>
              <label htmlFor="webhook-url">Address</label>
              <input
                id="webhook-url"
                type="url"
                inputMode="url"
                placeholder="https://"
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value);
                  setFormat(suggestFormat(event.target.value));
                }}
                autoComplete="off"
                required
              />
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                A public https address. WOLF refuses private and local addresses, and after saving shows only its
                host — addresses from Slack or Discord contain a password of their own.
              </div>
            </div>
            <div>
              <label htmlFor="webhook-format">Sends to</label>
              <select id="webhook-format" value={format} onChange={(event) => setFormat(event.target.value as WebhookFormat)}>
                {(Object.keys(FORMAT_LABELS) as WebhookFormat[]).map((id) => (
                  <option key={id} value={id}>
                    {FORMAT_LABELS[id]}
                  </option>
                ))}
              </select>
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                Slack and Discord accept only their own message shape, so WOLF sends them a short message. Chosen from
                the address; change it if the guess is wrong.
              </div>
            </div>
            <div>
              <label htmlFor="webhook-severity">Send</label>
              <select id="webhook-severity" value={minSeverity} onChange={(event) => setMinSeverity(event.target.value as AlertSeverity)}>
                {SEVERITIES.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              Sent: each notification’s title, detail, severity, time, and which PC. Adding a webhook needs your
              password.
            </div>
            <div>
              <button type="submit" disabled={busy !== null || webhooks.length >= limit}>
                {busy === 'create' ? 'Checking…' : 'Add webhook'}
              </button>
            </div>
          </form>
        </Panel>
      ) : null}

      {configured ? (
        <Panel title="Your webhooks">
          {webhooks.length === 0 ? (
            <Empty>No webhooks yet.</Empty>
          ) : (
            <div className="stack">
              {webhooks.map((webhook) => {
                const state = stateText(webhook);
                return (
                  <div key={webhook.id} className="stack" style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                    <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
                      <div>
                        <strong>{webhook.name}</strong> <span className="muted">{webhook.host} · {FORMAT_LABELS[webhook.format]}</span>
                      </div>
                      <span className={TONE[state.tone]}>{state.text}</span>
                    </div>
                    <div className="row" style={{ flexWrap: 'wrap' }}>
                      <select
                        aria-label={`What ${webhook.name} is sent`}
                        value={webhook.minSeverity}
                        disabled={busy !== null}
                        onChange={(event) =>
                          void act(webhook.id, async () => {
                            await updateWebhook(webhook.id, { minSeverity: event.target.value as AlertSeverity });
                            await load();
                          })
                        }
                      >
                        {SEVERITIES.map((entry) => (
                          <option key={entry.id} value={entry.id}>
                            {entry.label}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() =>
                          void act(webhook.id, async () => {
                            await updateWebhook(webhook.id, { enabled: !webhook.enabled });
                            await load();
                          })
                        }
                      >
                        {webhook.enabled ? 'Turn off' : 'Turn on'}
                      </button>
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() =>
                          void act(webhook.id, async () => {
                            const result = await testWebhook(webhook.id);
                            setNotice(`Test to ${webhook.host}: ${outcomeText(result.outcome, result.status)}.`);
                          })
                        }
                      >
                        {busy === webhook.id ? 'Sending…' : 'Send a test'}
                      </button>
                      <button type="button" disabled={busy !== null} onClick={() => void act(webhook.id, () => rotate(webhook))}>
                        Replace secret
                      </button>
                      <button
                        type="button"
                        className="button-danger"
                        disabled={busy !== null}
                        onClick={() =>
                          void act(webhook.id, async () => {
                            await deleteWebhook(webhook.id);
                            await load();
                          })
                        }
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>
      ) : null}
    </div>
  );
}
