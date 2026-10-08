-- Add VUs and duration columns to scenarios table
ALTER TABLE "scenarios" ADD COLUMN "vus" integer DEFAULT 1;
ALTER TABLE "scenarios" ADD COLUMN "duration_seconds" integer DEFAULT 30;
