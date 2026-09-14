'use client';

import { useState, type ChangeEvent } from 'react';
import { WolfApiError, type WolfProblem } from '@/lib/client';
import {
  getConfigurationBackup,
  previewRestore,
  restoreConfiguration,
  type ConfigurationSection,
  type RestorePlan,
} from '@/lib/wolf';
import { AppShell } from '@/components/AppShell';
import { Problem } from '@/components/ui';
import { useAuthority } from '@/components/use-authority';

const SECTIONS: { id: ConfigurationSection; label: string; note: string }[] = [
  { id: 'pcs', label: 'PC names and tags', note: 'Applied to PCs still enrolled. PCs themselves cannot be restored from a file.' },
  { id: 'remoteDesktopProfiles', label: 'Remote desktop profiles', note: 'Replaces your saved profiles.' },
  { id: 'alertRules', label: 'Alert rules', note: 'Replaces your alert rules.' },
  { id: 'automations', label: 'Automations', note: 'Replaces your automations. They come back turned off unless you choose otherwise.' },
];

const WARNING_TONE = 'status status-warn';

export default function ConfigurationPage() {
  return (
    <AppShell>
      <Configuration />
    </AppShell>
  );
}

function Configuration() {
  const [error, setError] = useState<WolfProblem | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [file, setFile] = useState<{ name: string; backup: unknown } | null>(null);
  const [sections, setSections] = useState<ConfigurationSection[]>(SECTIONS.map((section) => section.id));
  const [enableAutomations, setEnableAutomations] = useState(false);
  const [plan, setPlan] = useState<RestorePlan | null>(null);
  const [done, setDone] = useState<RestorePlan | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const { attempt, dialog } = useAuthority(setError);

  const download = async () => {
    setDownloading(true);
    setError(null);
    try {
      const backup = await getConfigurationBackup();
      // Made in the browser from the response. The server keeps no copy of the backup.
      const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `wolf-configuration-${backup.createdAt.slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (caught) {
      if (caught instanceof WolfApiError) setError(caught.problem);
    } finally {
      setDownloading(false);
    }
  };

  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0];
    setPlan(null);
    setDone(null);
    setError(null);
    if (!chosen) return;

    try {
      setFile({ name: chosen.name, backup: JSON.parse(await chosen.text()) });
    } catch {
      setFile(null);
      setError({
        code: 'configuration.unreadable',
        problem: 'That file could not be read as a backup.',
        cause: 'It is not valid JSON.',
        currentState: 'Nothing was changed.',
        recommendedAction: 'Choose a backup file downloaded from WOLF.',
        referenceId: 'WOLF-API-BACKUPFILE',
        httpStatus: 400,
      });
    }
  };

  const preview = async () => {
    if (!file) return;
    setPreviewing(true);
    setError(null);
    try {
      setPlan((await previewRestore({ backup: file.backup, sections, enableAutomations })).plan);
    } catch (caught) {
      if (caught instanceof WolfApiError) setError(caught.problem);
    } finally {
      setPreviewing(false);
    }
  };

  const restore = () => {
    if (!file || !plan) return;
    void attempt(
      'Restore configuration',
      async (confirmed) => {
        const result = await restoreConfiguration({ backup: file.backup, sections, enableAutomations, confirmedRiskLevel: confirmed });
        setDone(result.plan);
        setPlan(null);
      },
      enableAutomations && plan.automationsEnabled > 0
        ? `This replaces the chosen configuration and turns on ${plan.automationsEnabled} automation(s), which will then act on their own.`
        : 'This replaces the chosen configuration with the backup’s.',
    );
  };

  const toggle = (id: ConfigurationSection, on: boolean) => {
    setPlan(null);
    setSections(on ? [...sections, id] : sections.filter((entry) => entry !== id));
  };

  return (
    <div className="stack">
      <div>
        <h1>Configuration backup</h1>
        <p className="muted" style={{ margin: '2px 0 0' }}>
          Your PC names and tags, remote desktop profiles, alert rules and automations. A backup holds no passwords,
          keys, tokens or history, and WOLF keeps no copy of it — it is only the file you download.
        </p>
      </div>

      {error ? <Problem problem={error} /> : null}

      <section className="panel">
        <div className="panel-header">
          <strong>Back up</strong>
        </div>
        <div className="panel-body stack">
          <p className="muted" style={{ margin: 0 }}>
            The file carries a checksum, so a damaged or edited copy is refused when you restore it. Edit your
            configuration in WOLF, not in the file.
          </p>
          <div>
            <button type="button" className="button button-primary" disabled={downloading} onClick={() => void download()}>
              {downloading ? 'Preparing…' : 'Download backup'}
            </button>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <strong>Restore</strong>
        </div>
        <div className="panel-body stack">
          <input type="file" accept="application/json,.json" onChange={(event) => void choose(event)} aria-label="Backup file" />

          {file ? (
            <>
              <fieldset className="stack" style={{ gap: 6 }}>
                <legend>Restore these, replacing what is there now</legend>
                {SECTIONS.map((section) => (
                  <label key={section.id} className="row" style={{ gap: 6, alignItems: 'flex-start' }}>
                    <input type="checkbox" checked={sections.includes(section.id)} onChange={(event) => toggle(section.id, event.target.checked)} />
                    <span>
                      {section.label}
                      <span className="muted"> — {section.note}</span>
                    </span>
                  </label>
                ))}
                <label className="row" style={{ gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={enableAutomations}
                    disabled={!sections.includes('automations')}
                    onChange={(event) => {
                      setPlan(null);
                      setEnableAutomations(event.target.checked);
                    }}
                  />
                  Turn restored automations back on as they were (you confirm at the risk of the riskiest one)
                </label>
              </fieldset>

              <div className="row">
                <button type="button" className="button" disabled={previewing || sections.length === 0} onClick={() => void preview()}>
                  {previewing ? 'Checking…' : 'Check what will change'}
                </button>
                <button type="button" className="button button-danger" disabled={!plan} onClick={restore}>
                  Restore
                </button>
              </div>
            </>
          ) : null}

          {plan ? <PlanView plan={plan} heading="This restore will" /> : null}
          {done ? <PlanView plan={done} heading="Restored" /> : null}
        </div>
      </section>

      {dialog}
    </div>
  );
}

function PlanView({ plan, heading }: { plan: RestorePlan; heading: string }) {
  return (
    <div className="stack" style={{ gap: 6 }}>
      <strong>{heading}</strong>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Section</th>
              <th className="numeric">Create</th>
              <th className="numeric">Update</th>
              <th className="numeric">Delete</th>
              <th className="numeric">Skip</th>
            </tr>
          </thead>
          <tbody>
            {SECTIONS.filter((section) => plan.sections[section.id]).map((section) => {
              const counts = plan.sections[section.id]!;
              return (
                <tr key={section.id}>
                  <td>{section.label}</td>
                  <td className="numeric">{counts.created}</td>
                  <td className="numeric">{counts.updated}</td>
                  <td className="numeric">{counts.deleted}</td>
                  <td className="numeric">{counts.skipped}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        {plan.automationsEnabled > 0
          ? `${plan.automationsEnabled} automation(s) will be on. Confirmed at ${plan.riskLevel} risk.`
          : `Restored automations will be off. Confirmed at ${plan.riskLevel} risk.`}
      </p>
      {plan.warnings.map((warning) => (
        <div key={`${warning.code}:${warning.id}`} className="row" style={{ alignItems: 'flex-start' }}>
          <span className={WARNING_TONE}>note</span>
          <span>{warning.message}</span>
        </div>
      ))}
    </div>
  );
}
