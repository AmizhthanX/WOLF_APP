-- Webhooks: notifications sent as signed HTTPS requests to URLs the owner chose. See docs/architecture/webhooks.md.
--
-- The URL is stored encrypted, because Slack's and Discord's carry their credential in the path; the host is kept
-- beside it in the clear, for showing. The signing secret is not stored at all: it is derived from the server's
-- webhook key, the webhook's id and the salt below, so rotating it is replacing the salt.

CREATE TABLE IF NOT EXISTS webhooks (
    id                    CHAR(26) PRIMARY KEY,
    user_id               CHAR(26) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name                  TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    host                  TEXT NOT NULL,
    url_sealed            TEXT NOT NULL,
    secret_salt           TEXT NOT NULL,
    min_severity          TEXT NOT NULL CHECK (min_severity IN ('info', 'warning', 'critical')),
    enabled               BOOLEAN NOT NULL DEFAULT TRUE,
    disabled_reason       TEXT,
    consecutive_failures  INTEGER NOT NULL DEFAULT 0,
    last_delivery_at      TIMESTAMPTZ,
    last_outcome          TEXT,
    last_status           INTEGER,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webhooks_user_idx ON webhooks (user_id);

-- One row per notification per webhook it goes to: attempts, when to try next, and how it ended. The primary key
-- is the deduplication: a notification is fanned out to a webhook once, however many instances race.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    webhook_id       CHAR(26) NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    notification_id  CHAR(26) NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
    status           TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'failed')),
    attempts         INTEGER NOT NULL DEFAULT 0,
    next_attempt_at  TIMESTAMPTZ NOT NULL,
    lease_until      TIMESTAMPTZ,
    last_outcome     TEXT,
    last_status      INTEGER,
    created_at       TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (webhook_id, notification_id)
);

CREATE INDEX IF NOT EXISTS webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';

-- When this notification was fanned out to webhooks. Null: not yet.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS webhooked_at TIMESTAMPTZ;

-- Everything already in an inbox is history. Adding a webhook must not post the whole backlog to it.
UPDATE notifications SET webhooked_at = occurred_at WHERE webhooked_at IS NULL;

CREATE INDEX IF NOT EXISTS notifications_unwebhooked_idx ON notifications (occurred_at) WHERE webhooked_at IS NULL;

-- A webhook WOLF turned off tells the owner so in the inbox.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('fired', 'resolved', 'automation', 'webhook'));
