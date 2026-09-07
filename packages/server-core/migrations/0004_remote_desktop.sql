-- Remote desktop.
--
-- Two tables, and neither holds any picture of anyone's screen. WOLF records that a stream
-- existed, what it negotiated, and how it performed — never a frame, never audio, never a
-- keystroke. The stats column exists so "why was it laggy last Tuesday" has an answer
-- without retaining the content that would answer "what were you doing last Tuesday".

CREATE TABLE IF NOT EXISTS remote_desktop_profiles (
    id          CHAR(26) PRIMARY KEY,
    user_id     CHAR(26) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    -- Validated against the profile schema in @wolf/protocol before it is written.
    settings    JSONB NOT NULL,
    -- The profile a new stream uses when the client does not name one.
    is_default  BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, name)
);

-- At most one default per account, enforced by the database rather than by a read-then-write.
CREATE UNIQUE INDEX IF NOT EXISTS remote_desktop_profiles_default_idx
    ON remote_desktop_profiles (user_id)
    WHERE is_default;

CREATE TABLE IF NOT EXISTS stream_sessions (
    id                CHAR(26) PRIMARY KEY,
    session_id        CHAR(26) NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    pc_id             CHAR(26) NOT NULL REFERENCES pcs(id) ON DELETE CASCADE,
    user_id           CHAR(26) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id         CHAR(26) NOT NULL REFERENCES user_devices(id) ON DELETE CASCADE,

    display_id        TEXT,
    video_codec       TEXT,
    -- Whether the negotiated codec was encoded in hardware. The single most useful field
    -- when someone asks why a stream was soft.
    hardware_encoded  BOOLEAN,
    audio_enabled     BOOLEAN NOT NULL DEFAULT FALSE,

    state             TEXT NOT NULL DEFAULT 'STARTING'
                      CHECK (state IN ('STARTING', 'STREAMING', 'DEGRADED', 'RECONNECTING',
                                       'LOCKED', 'LOGIN', 'RESTARTING', 'OFFLINE')),
    route             TEXT CHECK (route IN ('lan', 'p2p', 'relay')),
    -- Why the stream is not running, when it is not. Distinguishes "the screen is locked"
    -- from "this machine has no encoder".
    unavailable_reason TEXT,

    -- Most recent stats sample. Metadata only: frame rate, bitrate, latency, loss.
    last_stats        JSONB,

    requested_profile JSONB NOT NULL,
    effective_profile JSONB,

    started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at          TIMESTAMPTZ,
    end_reason        TEXT
);

CREATE INDEX IF NOT EXISTS stream_sessions_pc_idx ON stream_sessions (pc_id, started_at DESC);
CREATE INDEX IF NOT EXISTS stream_sessions_active_idx ON stream_sessions (pc_id)
    WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS stream_sessions_session_idx ON stream_sessions (session_id);
