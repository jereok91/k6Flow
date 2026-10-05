CREATE TABLE "browser_states" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"source_url" text,
	"source_scenario_id" text,
	"storage_state" jsonb NOT NULL,
	"viewport_width" integer DEFAULT 1280 NOT NULL,
	"viewport_height" integer DEFAULT 720 NOT NULL,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "browser_states" ADD CONSTRAINT "browser_states_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_states" ADD CONSTRAINT "browser_states_source_scenario_id_scenarios_id_fk" FOREIGN KEY ("source_scenario_id") REFERENCES "public"."scenarios"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "browser_states_owner_id_idx" ON "browser_states" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "browser_states_source_scenario_idx" ON "browser_states" USING btree ("source_scenario_id");