-- Run ownership tracking for orchestrator proxy
-- Persists run ownership across server restarts

CREATE TABLE IF NOT EXISTS "run_ownership" (
  "run_id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "run_ownership_user_id_idx" ON "run_ownership" ("user_id");
