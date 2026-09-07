-- Partition maintenance for raw telemetry.
--
-- Raw samples arrive at roughly one row per second per PC. Retention is enforced by
-- dropping whole day partitions, which is instant, instead of deleting rows, which would
-- leave a bloated table and a long vacuum behind.

CREATE OR REPLACE FUNCTION wolf_ensure_telemetry_partitions(days_ahead INTEGER DEFAULT 3)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    day_offset INTEGER;
    partition_start DATE;
    partition_name TEXT;
    created INTEGER := 0;
BEGIN
    IF days_ahead < 1 OR days_ahead > 400 THEN
        RAISE EXCEPTION 'days_ahead must be between 1 and 400, got %', days_ahead;
    END IF;

    -- Yesterday is included so a late backfill from an agent that was offline still lands.
    FOR day_offset IN -1..days_ahead LOOP
        partition_start := (now() AT TIME ZONE 'UTC')::date + day_offset;
        partition_name := format('telemetry_samples_%s', to_char(partition_start, 'YYYYMMDD'));

        IF NOT EXISTS (
            SELECT 1 FROM pg_class WHERE relname = partition_name
        ) THEN
            EXECUTE format(
                'CREATE TABLE %I PARTITION OF telemetry_samples FOR VALUES FROM (%L) TO (%L)',
                partition_name,
                partition_start,
                partition_start + 1
            );
            -- BRIN suits an append-only, time-ordered partition at a fraction of the size
            -- of a btree.
            EXECUTE format(
                'CREATE INDEX %I ON %I USING brin (sampled_at)',
                partition_name || '_brin',
                partition_name
            );
            created := created + 1;
        END IF;
    END LOOP;

    RETURN created;
END;
$$;

-- Drop raw partitions older than the retention window. Returns the partitions removed so
-- the caller can log exactly what was deleted.
CREATE OR REPLACE FUNCTION wolf_drop_telemetry_partitions_before(cutoff DATE)
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $$
DECLARE
    partition_record RECORD;
    partition_date DATE;
BEGIN
    FOR partition_record IN
        SELECT c.relname
        FROM pg_class c
        JOIN pg_inherits i ON i.inhrelid = c.oid
        JOIN pg_class parent ON parent.oid = i.inhparent
        WHERE parent.relname = 'telemetry_samples'
    LOOP
        BEGIN
            partition_date := to_date(right(partition_record.relname, 8), 'YYYYMMDD');
        EXCEPTION WHEN OTHERS THEN
            CONTINUE;
        END;

        IF partition_date < cutoff THEN
            EXECUTE format('DROP TABLE IF EXISTS %I', partition_record.relname);
            RETURN NEXT partition_record.relname;
        END IF;
    END LOOP;
END;
$$;

SELECT wolf_ensure_telemetry_partitions(3);

-- Per-user retention configuration. Raw samples roll up into aggregates before their
-- partition is dropped, so long windows stay answerable without keeping every sample.
CREATE TABLE IF NOT EXISTS retention_settings (
    user_id           CHAR(26) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    raw_days          INTEGER NOT NULL DEFAULT 2 CHECK (raw_days BETWEEN 1 AND 30),
    five_minute_days  INTEGER NOT NULL DEFAULT 30 CHECK (five_minute_days BETWEEN 1 AND 400),
    hourly_days       INTEGER NOT NULL DEFAULT 180 CHECK (hourly_days BETWEEN 1 AND 1200),
    daily_days        INTEGER NOT NULL DEFAULT 365 CHECK (daily_days BETWEEN 1 AND 3650),
    audit_days        INTEGER NOT NULL DEFAULT 365 CHECK (audit_days BETWEEN 30 AND 3650),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
