'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { WolfApiError, type WolfProblem } from '@/lib/client';
import {
  createAutomation,
  deleteAutomation,
  listAlertRules,
  listAutomationRuns,
  listAutomations,
  listPcs,
  runAutomation,
  updateAutomation,
  type AlertRule,
  type AlertSeverity,
  type Automation,
  type AutomationAction,
  type AutomationCondition,
  type AutomationDefinition,
  type AutomationRun,
  type AutomationTrigger,
  type Pc,
  type RiskLevel,
  type Weekday,
} from '@/lib/wolf';
import { AppShell } from '@/components/AppShell';
import { Empty, Problem } from '@/components/ui';
import { useAuthority } from '@/components/use-authority';
import { relativeTime } from '@/lib/format';

const REFRESH_MS = 30_000;
const DAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const RISK_TONE: Record<RiskLevel, string> = {
  low: 'status status-offline',
  medium: 'status status-info',
  high: 'status status-warn',
  critical: 'status status-danger',
};

const RUN_TONE: Record<AutomationRun['status'], string> = {
  running: 'status status-info',
  completed: 'status status-online',
  failed: 'status status-danger',
  skipped: 'status status-offline',
  interrupted: 'status status-warn',
};

/** Words for the stable reason codes the server records. */
const REASONS: Record<string, string> = {
  cooldown: 'Cooling down since the last run',
  'daily-limit': 'Reached its runs-per-day limit',
  'condition-not-met': 'A condition was not met',
  'pc-offline': 'The PC was offline',
  'kill-switch': 'Remote access is switched off on the PC',
  'pc-unavailable': 'The PC is no longer enrolled',
  'unsupported-command': 'The PC does not support the action',
  'authority-revoked': 'The device that authorized it was revoked',
  'risk-escalated': 'Its actions now need more authorization than it has',
  'resource-held': 'Someone connected holds control of that on the PC',
  'stale-trigger': 'The alert was too long ago to act on',
};

function describeReason(reason: string | null): string {
  if (!reason) return '';
  const [code, ...rest] = reason.split(': ');
  const known = REASONS[code ?? ''];
  return known ? `${known}${rest.length ? ` — ${rest.join(': ')}` : ''}` : reason;
}

export default function AutomationsPage() {
  return (
    <AppShell>
      <Automations />
    </AppShell>
  );
}

function Automations() {
  const [automations, setAutomations] = useState<Automation[] | null>(null);
  const [limit, setLimit] = useState(0);
  const [pcs, setPcs] = useState<Pc[]>([]);
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [error, setError] = useState<WolfProblem | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, pcList, ruleList] = await Promise.all([listAutomations(), listPcs(), listAlertRules()]);
      setAutomations(list.automations);
      setLimit(list.limit);
      setPcs(pcList.pcs);
      setRules(ruleList.rules);
      setError(null);
    } catch (caught) {
      if (caught instanceof WolfApiError) setError(caught.problem);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const { attempt, dialog } = useAuthority(setError);

  const simple = async (work: () => Promise<unknown>) => {
    try {
      await work();
      await load();
    } catch (caught) {
      if (caught instanceof WolfApiError) setError(caught.problem);
    }
  };

  const pcName = (pcId: string) => pcs.find((pc) => pc.id === pcId)?.name ?? 'A removed PC';

  return (
    <div className="stack">
      <div>
        <h1>Automations</h1>
        <p className="muted" style={{ margin: '2px 0 0' }}>
          When something happens, and conditions hold, WOLF does these things. Saving an automation authorizes it:
          medium-risk actions need a confirmation, high-risk ones your password, and critical actions can never be
          automated.
        </p>
      </div>

      {error ? <Problem problem={error} onRetry={() => void load()} /> : null}

      <section className="panel">
        <div className="panel-header">
          <strong>Automations</strong>
          <span className="muted">{automations === null ? '' : `${automations.length} of ${limit}`}</span>
        </div>
        <div className="panel-body stack">
          {automations !== null && automations.length === 0 ? <Empty>No automations yet.</Empty> : null}
          {(automations ?? []).map((automation) => (
            <div key={automation.id} className="stack" style={{ gap: 6 }}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div>
                    <strong>{automation.name}</strong>{' '}
                    <span className={RISK_TONE[automation.authorizedRiskLevel]}>{automation.authorizedRiskLevel} risk</span>
                    {automation.enabled ? null : (
                      <span className="status status-offline" style={{ marginLeft: 6 }}>
                        Off
                      </span>
                    )}
                  </div>
                  <div className="muted">{summariseTrigger(automation.trigger, rules)}</div>
                  <div className="muted">
                    {automation.actions.map(summariseAction).join(', then ')} ·{' '}
                    {automation.targets.mode === 'pcs'
                      ? automation.targets.pcIds.map(pcName).join(', ')
                      : 'the PC the alert fired for'}
                  </div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    Last run {relativeTime(automation.lastRunAt)} · cooldown {automation.cooldownMinutes} min · at most{' '}
                    {automation.maxRunsPerDay} a day
                  </div>
                </div>
                <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  <button
                    type="button"
                    className="button-small"
                    disabled={!automation.enabled || automation.targets.mode !== 'pcs'}
                    onClick={() => void simple(() => runAutomation(automation.id)).then(() => setExpanded(automation.id))}
                  >
                    Run now
                  </button>
                  <button
                    type="button"
                    className="button-small"
                    onClick={() =>
                      automation.enabled
                        ? void simple(() => updateAutomation(automation.id, { enabled: false }))
                        : void attempt(`Turn on "${automation.name}"`, async (confirmed) => {
                            await updateAutomation(automation.id, { enabled: true }, confirmed);
                            await load();
                          })
                    }
                  >
                    {automation.enabled ? 'Turn off' : 'Turn on'}
                  </button>
                  <button
                    type="button"
                    className="button-small"
                    onClick={() => setExpanded(expanded === automation.id ? null : automation.id)}
                  >
                    History
                  </button>
                  <button
                    type="button"
                    className="button-small button-danger"
                    onClick={() => {
                      if (window.confirm(`Delete "${automation.name}"? Its run history goes with it.`)) {
                        void simple(() => deleteAutomation(automation.id));
                      }
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
              {expanded === automation.id ? <RunHistory automationId={automation.id} pcName={pcName} /> : null}
            </div>
          ))}
        </div>
      </section>

      <NewAutomation
        pcs={pcs}
        rules={rules}
        onSave={(definition) =>
          attempt(`Authorize "${definition.name}"`, async (confirmed) => {
            await createAutomation(definition, confirmed);
            await load();
          })
        }
      />

      {dialog}
    </div>
  );
}

function RunHistory({ automationId, pcName }: { automationId: string; pcName: (pcId: string) => string }) {
  const [runs, setRuns] = useState<AutomationRun[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const result = await listAutomationRuns(automationId);
        if (!cancelled) setRuns(result.runs);
      } catch {
        if (!cancelled) setRuns([]);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [automationId]);

  if (runs === null) return <p className="muted">Loading history…</p>;
  if (runs.length === 0) return <p className="muted">It has not run yet.</p>;

  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Trigger</th>
            <th>PC</th>
            <th>Outcome</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id}>
              <td>{relativeTime(run.startedAt)}</td>
              <td className="secondary">{run.triggerKind}</td>
              <td>{run.pcId ? pcName(run.pcId) : '—'}</td>
              <td>
                <span className={RUN_TONE[run.status]}>{run.status}</span>
                {run.reason ? <div className="muted">{describeReason(run.reason)}</div> : null}
              </td>
              <td className="secondary">
                {run.steps.length === 0
                  ? '—'
                  : run.steps
                      .map((step) => `${step.commandType ?? step.kind}: ${step.status}${step.detail ? ` (${step.detail})` : ''}`)
                      .join('; ')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function summariseTrigger(trigger: AutomationTrigger, rules: AlertRule[]): string {
  switch (trigger.kind) {
    case 'manual':
      return 'Only when run by hand';
    case 'schedule':
      return `At ${trigger.time} on ${trigger.days.length === 7 ? 'every day' : trigger.days.join(', ')} (${trigger.timeZone})`;
    case 'alert': {
      const rule = trigger.ruleId ? rules.find((entry) => entry.id === trigger.ruleId)?.name ?? 'a deleted rule' : 'any alert rule';
      return `When ${rule} ${trigger.on === 'fired' ? 'fires' : 'resolves'}`;
    }
  }
}

function summariseAction(action: AutomationAction): string {
  if (action.kind === 'notify') return `notify "${action.message}"`;
  const payload = action.command.payload;
  switch (action.command.type) {
    case 'power.action':
      return `${String(payload['action'])} the PC`;
    case 'service.control':
      return `${String(payload['action'])} service ${String(payload['name'])}`;
    case 'task.control':
      return `${String(payload['action'])} task ${String(payload['path'])}`;
    case 'startup.set-enabled':
      return `${payload['enabled'] ? 'enable' : 'disable'} startup item ${String(payload['name'])}`;
    default:
      return action.command.type;
  }
}

/* ------------------------------------------------------------------------- */
/* Builder                                                                    */
/* ------------------------------------------------------------------------- */

type ActionDraft =
  | { kind: 'notify'; severity: AlertSeverity; message: string }
  | { kind: 'power'; action: string; delaySeconds: number }
  | { kind: 'service'; name: string; displayName: string; action: string }
  | { kind: 'task'; path: string; name: string; action: string }
  | { kind: 'startup'; name: string; scope: string; source: string; enabled: boolean };

function toAction(draft: ActionDraft): AutomationAction {
  switch (draft.kind) {
    case 'notify':
      return { kind: 'notify', severity: draft.severity, message: draft.message };
    case 'power':
      return { kind: 'command', command: { type: 'power.action', payload: { action: draft.action, delaySeconds: draft.delaySeconds, force: false } } };
    case 'service':
      return { kind: 'command', command: { type: 'service.control', payload: { name: draft.name, action: draft.action, expectedDisplayName: draft.displayName } } };
    case 'task':
      return { kind: 'command', command: { type: 'task.control', payload: { path: draft.path, action: draft.action, expectedName: draft.name } } };
    case 'startup':
      return { kind: 'command', command: { type: 'startup.set-enabled', payload: { name: draft.name, scope: draft.scope, source: draft.source, enabled: draft.enabled } } };
  }
}

function blankAction(kind: ActionDraft['kind']): ActionDraft {
  switch (kind) {
    case 'notify':
      return { kind, severity: 'info', message: '' };
    case 'power':
      return { kind, action: 'restart', delaySeconds: 60 };
    case 'service':
      return { kind, name: '', displayName: '', action: 'restart' };
    case 'task':
      return { kind, path: '', name: '', action: 'run' };
    case 'startup':
      return { kind, name: '', scope: 'user', source: 'run', enabled: false };
  }
}

function NewAutomation({
  pcs,
  rules,
  onSave,
}: {
  pcs: Pc[];
  rules: AlertRule[];
  onSave: (definition: AutomationDefinition) => Promise<void>;
}) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [name, setName] = useState('');
  const [triggerKind, setTriggerKind] = useState<AutomationTrigger['kind']>('schedule');
  const [time, setTime] = useState('03:00');
  const [days, setDays] = useState<Weekday[]>([...DAYS]);
  const [timeZone, setTimeZone] = useState(zone);
  const [ruleId, setRuleId] = useState('');
  const [on, setOn] = useState<'fired' | 'resolved'>('fired');
  const [alertPc, setAlertPc] = useState(true);
  const [pcIds, setPcIds] = useState<string[]>([]);
  const [noSession, setNoSession] = useState(true);
  const [windowOn, setWindowOn] = useState(false);
  const [windowStart, setWindowStart] = useState('22:00');
  const [windowEnd, setWindowEnd] = useState('06:00');
  const [idleOn, setIdleOn] = useState(false);
  const [idleBelow, setIdleBelow] = useState(20);
  const [actions, setActions] = useState<ActionDraft[]>([blankAction('notify')]);
  const [cooldownMinutes, setCooldownMinutes] = useState(60);
  const [maxRunsPerDay, setMaxRunsPerDay] = useState(4);
  const [busy, setBusy] = useState(false);

  const trigger: AutomationTrigger =
    triggerKind === 'schedule'
      ? { kind: 'schedule', time, days, timeZone }
      : triggerKind === 'alert'
        ? { kind: 'alert', ruleId: ruleId === '' ? null : ruleId, on }
        : { kind: 'manual' };

  const conditions: AutomationCondition[] = [];
  if (noSession) conditions.push({ kind: 'no-active-session' });
  if (windowOn) conditions.push({ kind: 'time-window', start: windowStart, end: windowEnd, days: [...DAYS], timeZone });
  if (idleOn) conditions.push({ kind: 'metric', metric: 'cpu.usage', seriesKey: null, comparison: 'below', threshold: idleBelow });

  const useAlertPc = triggerKind === 'alert' && alertPc;
  const ready = name.trim() !== '' && actions.length > 0 && (useAlertPc || pcIds.length > 0) && days.length > 0;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await onSave({
        name: name.trim(),
        enabled: true,
        trigger,
        conditions,
        actions: actions.map(toAction),
        targets: useAlertPc ? { mode: 'alert-pc' } : { mode: 'pcs', pcIds },
        cooldownMinutes,
        maxRunsPerDay,
      });
    } finally {
      setBusy(false);
    }
  };

  const updateAction = (index: number, next: ActionDraft) => setActions(actions.map((entry, at) => (at === index ? next : entry)));

  return (
    <form className="panel" onSubmit={(event) => void submit(event)}>
      <div className="panel-header">
        <strong>New automation</strong>
      </div>
      <div className="panel-body stack">
        <label className="stack" style={{ gap: 4 }}>
          Name
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required />
        </label>

        <fieldset className="stack" style={{ gap: 6 }}>
          <legend>When</legend>
          <select value={triggerKind} onChange={(event) => setTriggerKind(event.target.value as AutomationTrigger['kind'])}>
            <option value="schedule">On a schedule</option>
            <option value="alert">When an alert changes</option>
            <option value="manual">Only when I run it</option>
          </select>
          {triggerKind === 'schedule' ? (
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <input type="time" value={time} onChange={(event) => setTime(event.target.value)} required />
              {DAYS.map((day) => (
                <label key={day} className="row" style={{ gap: 2 }}>
                  <input
                    type="checkbox"
                    checked={days.includes(day)}
                    onChange={(event) => setDays(event.target.checked ? [...days, day] : days.filter((entry) => entry !== day))}
                  />
                  {day}
                </label>
              ))}
              <input value={timeZone} onChange={(event) => setTimeZone(event.target.value)} aria-label="Time zone" style={{ width: 180 }} />
            </div>
          ) : null}
          {triggerKind === 'alert' ? (
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <select value={ruleId} onChange={(event) => setRuleId(event.target.value)}>
                <option value="">Any alert rule</option>
                {rules.map((rule) => (
                  <option key={rule.id} value={rule.id}>
                    {rule.name}
                  </option>
                ))}
              </select>
              <select value={on} onChange={(event) => setOn(event.target.value as 'fired' | 'resolved')}>
                <option value="fired">fires</option>
                <option value="resolved">resolves</option>
              </select>
            </div>
          ) : null}
        </fieldset>

        <fieldset className="stack" style={{ gap: 6 }}>
          <legend>On which PCs</legend>
          {triggerKind === 'alert' ? (
            <label className="row" style={{ gap: 4 }}>
              <input type="checkbox" checked={alertPc} onChange={(event) => setAlertPc(event.target.checked)} />
              The PC the alert fired for
            </label>
          ) : null}
          {!useAlertPc ? (
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {pcs.map((pc) => (
                <label key={pc.id} className="row" style={{ gap: 4 }}>
                  <input
                    type="checkbox"
                    checked={pcIds.includes(pc.id)}
                    onChange={(event) => setPcIds(event.target.checked ? [...pcIds, pc.id] : pcIds.filter((entry) => entry !== pc.id))}
                  />
                  {pc.name}
                </label>
              ))}
            </div>
          ) : null}
        </fieldset>

        <fieldset className="stack" style={{ gap: 6 }}>
          <legend>Only if</legend>
          <label className="row" style={{ gap: 4 }}>
            <input type="checkbox" checked={noSession} onChange={(event) => setNoSession(event.target.checked)} />
            Nobody is connected to the PC
          </label>
          <label className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
            <input type="checkbox" checked={windowOn} onChange={(event) => setWindowOn(event.target.checked)} />
            Between
            <input type="time" value={windowStart} onChange={(event) => setWindowStart(event.target.value)} disabled={!windowOn} />
            and
            <input type="time" value={windowEnd} onChange={(event) => setWindowEnd(event.target.value)} disabled={!windowOn} />
          </label>
          <label className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
            <input type="checkbox" checked={idleOn} onChange={(event) => setIdleOn(event.target.checked)} />
            CPU is below
            <input
              type="number"
              min={1}
              max={100}
              value={idleBelow}
              onChange={(event) => setIdleBelow(Number(event.target.value))}
              disabled={!idleOn}
              style={{ width: 70 }}
            />
            % (a PC that is not reporting does not count as idle)
          </label>
        </fieldset>

        <fieldset className="stack" style={{ gap: 6 }}>
          <legend>Do, in order</legend>
          {actions.map((action, index) => (
            <div key={index} className="row" style={{ flexWrap: 'wrap' }}>
              <select
                value={action.kind}
                onChange={(event) => updateAction(index, blankAction(event.target.value as ActionDraft['kind']))}
              >
                <option value="notify">Notify me</option>
                <option value="power">Power</option>
                <option value="service">Windows service</option>
                <option value="task">Scheduled task</option>
                <option value="startup">Startup item</option>
              </select>
              <ActionFields action={action} onChange={(next) => updateAction(index, next)} />
              <button type="button" className="button-small" onClick={() => setActions(actions.filter((_, at) => at !== index))}>
                Remove
              </button>
            </div>
          ))}
          {actions.length < 5 ? (
            <div>
              <button type="button" className="button-small" onClick={() => setActions([...actions, blankAction('notify')])}>
                Add action
              </button>
            </div>
          ) : null}
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            Each action waits for the one before it to finish; if one fails, the rest are skipped. Actions that name a
            process by its PID, and forced power actions, cannot be automated.
          </p>
        </fieldset>

        <div className="row" style={{ flexWrap: 'wrap' }}>
          <label className="stack" style={{ gap: 4 }}>
            Wait between runs on a PC (minutes)
            <input type="number" min={1} max={10080} value={cooldownMinutes} onChange={(event) => setCooldownMinutes(Number(event.target.value))} style={{ width: 110 }} />
          </label>
          <label className="stack" style={{ gap: 4 }}>
            At most this many runs a day
            <input type="number" min={1} max={96} value={maxRunsPerDay} onChange={(event) => setMaxRunsPerDay(Number(event.target.value))} style={{ width: 110 }} />
          </label>
        </div>

        <div>
          <button type="submit" className="button button-primary" disabled={busy || !ready}>
            Save and authorize
          </button>
        </div>
      </div>
    </form>
  );
}

function ActionFields({ action, onChange }: { action: ActionDraft; onChange: (next: ActionDraft) => void }) {
  switch (action.kind) {
    case 'notify':
      return (
        <>
          <input
            placeholder="Message"
            value={action.message}
            maxLength={200}
            onChange={(event) => onChange({ ...action, message: event.target.value })}
            required
          />
          <select value={action.severity} onChange={(event) => onChange({ ...action, severity: event.target.value as AlertSeverity })}>
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </select>
        </>
      );
    case 'power':
      return (
        <>
          <select value={action.action} onChange={(event) => onChange({ ...action, action: event.target.value })}>
            {['lock', 'sign-out', 'sleep', 'hibernate', 'restart', 'shutdown'].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          after
          <input
            type="number"
            min={0}
            max={86400}
            value={action.delaySeconds}
            onChange={(event) => onChange({ ...action, delaySeconds: Number(event.target.value) })}
            style={{ width: 90 }}
          />
          seconds
        </>
      );
    case 'service':
      return (
        <>
          <select value={action.action} onChange={(event) => onChange({ ...action, action: event.target.value })}>
            {['start', 'stop', 'restart'].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <input placeholder="Service name, e.g. Spooler" value={action.name} onChange={(event) => onChange({ ...action, name: event.target.value })} required />
          <input
            placeholder="Display name, e.g. Print Spooler"
            value={action.displayName}
            onChange={(event) => onChange({ ...action, displayName: event.target.value })}
            required
          />
        </>
      );
    case 'task':
      return (
        <>
          <select value={action.action} onChange={(event) => onChange({ ...action, action: event.target.value })}>
            {['run', 'enable', 'disable'].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <input placeholder="Task path, e.g. \\Backup\\Nightly" value={action.path} onChange={(event) => onChange({ ...action, path: event.target.value })} required />
          <input placeholder="Task name" value={action.name} onChange={(event) => onChange({ ...action, name: event.target.value })} required />
        </>
      );
    case 'startup':
      return (
        <>
          <select value={String(action.enabled)} onChange={(event) => onChange({ ...action, enabled: event.target.value === 'true' })}>
            <option value="false">disable</option>
            <option value="true">enable</option>
          </select>
          <input placeholder="Entry name" value={action.name} onChange={(event) => onChange({ ...action, name: event.target.value })} required />
          <select value={action.scope} onChange={(event) => onChange({ ...action, scope: event.target.value })}>
            <option value="user">for the signed-in user</option>
            <option value="machine">for everyone</option>
          </select>
          <select value={action.source} onChange={(event) => onChange({ ...action, source: event.target.value })}>
            <option value="run">Run key</option>
            <option value="run-once">RunOnce key</option>
            <option value="startup-folder">Startup folder</option>
          </select>
        </>
      );
  }
}
