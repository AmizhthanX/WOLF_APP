-- Webhook formats: WOLF's own JSON, or the message shape Slack's or Discord's incoming webhooks accept.
-- A new migration rather than an edit to 0009: applied migrations are checksummed, and a changed file is an error.

ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS format TEXT NOT NULL DEFAULT 'wolf'
    CHECK (format IN ('wolf', 'slack', 'discord'));
