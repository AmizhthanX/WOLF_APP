-- Alert rules, their per-target state, and the notifications they produce.
--
-- A rule is a question WOLF keeps asking on the owner's behalf. The state table is where the
-- last answer is kept, one row per rule, PC and series — so that the owner is told when the
-- answer *changes*, rather than every minute it stays the same.

CREATE TABLE IF NOT EXISTS alert_rules (
    id                CHAR(26) PRIMARY KEY,
    user_id           CHAR(26) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Null targets every PC on the account, including ones enrolled after the rule was made.
    pc_id             CHAR(26) REFERENCES pcs(id) ON DELETE CASCADE,
    name              TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
    condition         TEXT NOT NULL CHECK (condition IN ('metric-above', 'metric-below', 'pc-offline')),
    metric            TEXT,
    series_key        TEXT,
    threshold         DOUBLE PRECISION,
    for_minutes       INTEGER NOT NULL CHECK (for_minutes BETWEEN 1 AND 1440),
    severity          TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
    cooldown_minutes  INTEGER NOT NULL CHECK (cooldown_minutes BETWEEN 5 AND 10080),
    enabled           BOOLEAN NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- The same coherence the API checks, held by the database as well: a metric rule with no
    -- metric or no threshold is a rule its owner believes is watching something.
    CONSTRAINT alert_rules_metric_coherent CHECK (
        condition = 'pc-offline' OR (metric IS NOT NULL AND threshold IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS alert_rules_user_idx ON alert_rules (user_id);
CREATE INDEX IF NOT EXISTS alert_rules_enabled_idx ON alert_rules (user_id) WHERE enabled;

CREATE TABLE IF NOT EXISTS alert_states (
    rule_id           CHAR(26) NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
    pc_id             CHAR(26) NOT NULL REFERENCES pcs(id) ON DELETE CASCADE,
    -- Empty rather than null for whole-machine metrics, because a primary key cannot hold a
    -- null and a unique index would treat two nulls as different rows.
    series_key        TEXT NOT NULL DEFAULT '',
    state             TEXT NOT NULL CHECK (state IN ('ok', 'firing')),
    changed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_notified_at  TIMESTAMPTZ,
    -- Whether the current firing produced a notification. A firing suppressed by the cooldown
    -- must not produce a "resolved" notification for an alert the owner was never told about.
    notified          BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (rule_id, pc_id, series_key)
);

CREATE TABLE IF NOT EXISTS notifications (
    id           CHAR(26) PRIMARY KEY,
    user_id      CHAR(26) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Set null rather than cascaded: deleting a rule must not rewrite the history of what the
    -- owner was told.
    rule_id      CHAR(26) REFERENCES alert_rules(id) ON DELETE SET NULL,
    pc_id        CHAR(26) REFERENCES pcs(id) ON DELETE SET NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('fired', 'resolved')),
    severity     TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
    title        TEXT NOT NULL,
    detail       TEXT NOT NULL,
    metric       TEXT,
    series_key   TEXT,
    value        DOUBLE PRECISION,
    threshold    DOUBLE PRECISION,
    occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    read_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS notifications_user_time_idx ON notifications (user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;
