-- Privileged grants.
--
-- A critical-risk action (remote unlock, administrative terminal, destructive file
-- operations) needs more than a valid session: it needs an explicit, single-use grant that
-- was created after a fresh password re-entry, scoped to one PC and one session, and
-- short-lived. Consuming a grant is part of authorizing the command, so one grant can
-- never authorize two actions.

CREATE TABLE IF NOT EXISTS privileged_grants (
    id           CHAR(26) PRIMARY KEY,
    user_id      CHAR(26) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id    CHAR(26) NOT NULL REFERENCES user_devices(id) ON DELETE CASCADE,
    pc_id        CHAR(26) NOT NULL REFERENCES pcs(id) ON DELETE CASCADE,
    session_id   CHAR(26) REFERENCES sessions(id) ON DELETE CASCADE,
    -- What the grant was requested for, recorded so the audit trail shows intent even when
    -- the grant goes unused.
    purpose      TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL,
    consumed_at  TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS privileged_grants_active_idx
    ON privileged_grants (user_id, pc_id)
    WHERE consumed_at IS NULL AND revoked_at IS NULL;
