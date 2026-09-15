-- Push wake-ups for phones. See docs/architecture/push.md.
--
-- A wake-up says only that there is something new. What is new stays here, and the phone fetches it over
-- its own authenticated connection, so nothing a push service carries is about the owner's machines.

CREATE TABLE IF NOT EXISTS device_push_tokens (
    device_id   CHAR(26) PRIMARY KEY REFERENCES user_devices(id) ON DELETE CASCADE,
    user_id     CHAR(26) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider    TEXT NOT NULL CHECK (provider IN ('fcm')),
    -- The provider's registration token. It addresses one device and nothing else; it is never logged,
    -- audited or returned by the API.
    token       TEXT NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS device_push_tokens_user_idx ON device_push_tokens (user_id);

-- When this notification was considered for a wake-up: sent, or too old to be news. Null: not yet.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS pushed_at TIMESTAMPTZ;

-- Everything already in an inbox is history, not news. Without this, turning push on would wake every phone
-- for every notification ever written.
UPDATE notifications SET pushed_at = occurred_at WHERE pushed_at IS NULL;

CREATE INDEX IF NOT EXISTS notifications_unpushed_idx ON notifications (occurred_at) WHERE pushed_at IS NULL;
