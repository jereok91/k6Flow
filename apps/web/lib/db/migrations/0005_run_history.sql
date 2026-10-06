-- Expand run_ownership to store run history details

ALTER TABLE "run_ownership" ADD COLUMN IF NOT EXISTS "scenario_id" text REFERENCES "scenarios"("id") ON DELETE SET NULL;
ALTER TABLE "run_ownership" ADD COLUMN IF NOT EXISTS "scenario_name" text;
ALTER TABLE "run_ownership" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'running' NOT NULL;
ALTER TABLE "run_ownership" ADD COLUMN IF NOT EXISTS "vus" integer DEFAULT 1;
ALTER TABLE "run_ownership" ADD COLUMN IF NOT EXISTS "duration_ms" integer;
ALTER TABLE "run_ownership" ADD COLUMN IF NOT EXISTS "completed_at" timestamp;
ALTER TABLE "run_ownership" ADD COLUMN IF NOT EXISTS "iterations" integer DEFAULT 0;
ALTER TABLE "run_ownership" ADD COLUMN IF NOT EXISTS "avg_duration_ms" real;
ALTER TABLE "run_ownership" ADD COLUMN IF NOT EXISTS "error_rate" real;

CREATE INDEX IF NOT EXISTS "run_ownership_scenario_id_idx" ON "run_ownership" ("scenario_id");
CREATE INDEX IF NOT EXISTS "run_ownership_status_idx" ON "run_ownership" ("status");
