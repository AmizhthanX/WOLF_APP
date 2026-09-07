-- Whether a PC can actually stream, as distinct from whether it has the parts.
--
-- Detecting a hardware encoder tells you the machine *could* encode video. It does not tell
-- you that WOLF can capture the screen right now — nobody may be signed in, the workstation
-- may be locked, or the agent build may not implement capture yet. Conflating the two is
-- how a dashboard ends up offering a stream that can never start, so the agent reports the
-- answer directly instead of leaving the cloud to infer it.

ALTER TABLE pc_capabilities
    ADD COLUMN IF NOT EXISTS remote_desktop_available BOOLEAN NOT NULL DEFAULT FALSE;

-- The reason, when the answer is no. A code from the protocol's stream-unavailable list,
-- so the UI can distinguish "wait, someone is signing in" from "this will never work here".
ALTER TABLE pc_capabilities
    ADD COLUMN IF NOT EXISTS remote_desktop_unavailable_reason TEXT;

-- Every encoder the machine has, hardware and software. The existing
-- hardware_video_encoders column keeps only the hardware ones, which is what codec
-- negotiation prefers; this one is what an operator looks at when asking why a stream is
-- costing 30% of a CPU.
ALTER TABLE pc_capabilities
    ADD COLUMN IF NOT EXISTS video_encoders TEXT[] NOT NULL DEFAULT '{}';
