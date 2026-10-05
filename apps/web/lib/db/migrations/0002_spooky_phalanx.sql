CREATE TABLE "folders" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"parent_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recordings" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"start_url" text NOT NULL,
	"state" text DEFAULT 'recording' NOT NULL,
	"viewport_width" integer DEFAULT 1280 NOT NULL,
	"viewport_height" integer DEFAULT 720 NOT NULL,
	"duration_ms" integer,
	"request_count" integer DEFAULT 0,
	"step_count" integer DEFAULT 0,
	"capture_data" text,
	"scenario_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	CONSTRAINT "recordings_state_check" CHECK ("recordings"."state" IN ('recording', 'completed', 'failed', 'processing'))
);
--> statement-breakpoint
CREATE TABLE "scenario_tags" (
	"scenario_id" text NOT NULL,
	"tag_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scenario_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"scenario_id" text NOT NULL,
	"version" integer NOT NULL,
	"graph" jsonb NOT NULL,
	"change_description" text,
	"source_recording_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"created_by" text
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#6B7280',
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scenarios" ADD COLUMN "folder_id" text;--> statement-breakpoint
ALTER TABLE "scenarios" ADD COLUMN "is_favorite" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_parent_id_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_scenario_id_scenarios_id_fk" FOREIGN KEY ("scenario_id") REFERENCES "public"."scenarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenario_tags" ADD CONSTRAINT "scenario_tags_scenario_id_scenarios_id_fk" FOREIGN KEY ("scenario_id") REFERENCES "public"."scenarios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenario_tags" ADD CONSTRAINT "scenario_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenario_versions" ADD CONSTRAINT "scenario_versions_scenario_id_scenarios_id_fk" FOREIGN KEY ("scenario_id") REFERENCES "public"."scenarios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenario_versions" ADD CONSTRAINT "scenario_versions_source_recording_id_recordings_id_fk" FOREIGN KEY ("source_recording_id") REFERENCES "public"."recordings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenario_versions" ADD CONSTRAINT "scenario_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "folders_owner_id_idx" ON "folders" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "folders_parent_id_idx" ON "folders" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "recordings_owner_id_idx" ON "recordings" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "recordings_state_idx" ON "recordings" USING btree ("state");--> statement-breakpoint
CREATE INDEX "recordings_scenario_id_idx" ON "recordings" USING btree ("scenario_id");--> statement-breakpoint
CREATE INDEX "scenario_tags_scenario_id_idx" ON "scenario_tags" USING btree ("scenario_id");--> statement-breakpoint
CREATE INDEX "scenario_tags_tag_id_idx" ON "scenario_tags" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "scenario_versions_scenario_id_idx" ON "scenario_versions" USING btree ("scenario_id");--> statement-breakpoint
CREATE INDEX "scenario_versions_unique_idx" ON "scenario_versions" USING btree ("scenario_id","version");--> statement-breakpoint
CREATE INDEX "tags_owner_id_idx" ON "tags" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "tags_owner_name_idx" ON "tags" USING btree ("owner_id","name");--> statement-breakpoint
CREATE INDEX "scenarios_folder_id_idx" ON "scenarios" USING btree ("folder_id");