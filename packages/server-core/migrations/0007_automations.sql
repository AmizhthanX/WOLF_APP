-- Automations: triggers, conditions, actions, cooldowns — and the authority behind them.
--
-- An automation acts when nobody is watching, so the row carries not only what to do but who
-- decided it, from which device, and at what risk level. A run that would exceed that level, or
-- whose authorizing device has since been revoked, does nothing.

CREATE TABLE IF NOT EXISTS automations (
    id                    CHAR(26) PRIMARY KEY,
    user_id               CHAR(26) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name                  TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
    enabled               BOOLEAN NOT NULL DEFAULT TRUE,
    trigger_kind          TEXT NOT NULL CHECK (trigger_kind IN ('schedule', 'alert', 'manual')),
    trigger               JSONB NOT NULL,
    conditions            JSONB NOT NULL DEFAULT '[]'::jsonb,
    actions               JSONB NOT NULL,
    targets               JSONB NOT NULL,
    cooldown_minutes      INTEGER NOT NULL CHECK (cooldown_minutes BETWEEN 1 AND 10080),
    max_runs_per_day      INTEGER NOT NULL CHECK (max_runs_per_day BETWEEN 1 AND 96),
    -- Never critical: a critical action needs a single-use grant per action, and a standing
    -- automation would turn it into a standing permission. Held here as well as in the API.
    authorized_risk       TEXT NOT NULL CHECK (authorized_risk IN ('low', 'medium', 'high')),
    authorized_device_id  CHAR(26) NOT NULL REFERENCES user_devices(id) ON DELETE CASCADE,
    authorized_at         TIMESTAMPTZ NOT NULL,
    last_run_at           TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS automations_user_idx ON automations (user_id);
CREATE INDEX IF NOT EXISTS automations_enabled_trigger_idx ON automations (trigger_kind) WHERE enabled;

-- When each automation last ran on each PC: the cooldown, claimed by compare-and-set so two API
-- instances cannot both start a run.
CREATE TABLE IF NOT EXISTS automation_pc_state (
    automation_id  CHAR(26) NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
    pc_id          CHAR(26) NOT NULL REFERENCES pcs(id) ON DELETE CASCADE,
    last_run_at    TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (automation_id, pc_id)
);

-- Scheduled minutes already fired, by local date and time. The primary key is the deduplication:
-- the second instance to reach 03:00, or the repeated 01:30 of a daylight-saving change, inserts
-- nothing and runs nothing.
CREATE TABLE IF NOT EXISTS automation_schedule_slots (
    automation_id  CHAR(26) NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
    slot           TEXT NOT NULL,
    fired_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (automation_id, slot)
);

-- Things that happened which an automation might act on. Written by the alert evaluator in the
-- same transaction as the state change, so an alert that fired exactly once produces exactly one
-- event; claimed once by whichever instance gets there first.
CREATE TABLE IF NOT EXISTS automation_events (
    id           CHAR(26) PRIMARY KEY,
    user_id      CHAR(26) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL CHECK (kind IN ('alert-fired', 'alert-resolved')),
    rule_id      CHAR(26) REFERENCES alert_rules(id) ON DELETE CASCADE,
    pc_id        CHAR(26) NOT NULL REFERENCES pcs(id) ON DELETE CASCADE,
    occurred_at  TIMESTAMPTZ NOT NULL,
    claimed_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS automation_events_unclaimed_idx ON automation_events (occurred_at) WHERE claimed_at IS NULL;

CREATE TABLE IF NOT EXISTS automation_runs (
    id                CHAR(26) PRIMARY KEY,
    automation_id     CHAR(26) NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
    user_id           CHAR(26) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pc_id             CHAR(26) REFERENCES pcs(id) ON DELETE SET NULL,
    trigger_kind      TEXT NOT NULL CHECK (trigger_kind IN ('schedule', 'alert', 'manual')),
    status            TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'skipped', 'interrupted')),
    reason            TEXT,
    -- Per-action outcomes: kind, status, command id, a short code. Never a command's result.
    steps             JSONB NOT NULL DEFAULT '[]'::jsonb,
    started_at        TIMESTAMPTZ NOT NULL,
    finished_at       TIMESTAMPTZ,
    -- A running run whose lease lapses belonged to an instance that died. It is marked
    -- interrupted, never resumed: finishing half a restart sequence an hour later is running late.
    lease_expires_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS automation_runs_automation_idx ON automation_runs (automation_id, started_at DESC);
CREATE INDEX IF NOT EXISTS automation_runs_running_idx ON automation_runs (lease_expires_at) WHERE status = 'running';

-- Notifications can now come from an automation as well as an alert rule.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS automation_id CHAR(26) REFERENCES automations(id) ON DELETE SET NULL;
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('fired', 'resolved', 'automation'));
