import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    role: text("role").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [check("users_role_check", sql`${t.role} IN ('admin', 'user')`)],
);

export const sessions = pgTable(
  "sessions",
  {
    token: text("token").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

export const scenarios = pgTable(
  "scenarios",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    graph: jsonb("graph").notNull(),
    // K6R6-06: Optional folder for organization
    folderId: text("folder_id"),
    // K6R6-06: Favorite flag
    isFavorite: integer("is_favorite").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("scenarios_owner_id_idx").on(t.ownerId),
    index("scenarios_folder_id_idx").on(t.folderId),
  ],
);

// K6F6-01: Attachments for CSV user pools
export const attachments = pgTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    scenarioId: text("scenario_id")
      .notNull()
      .references(() => scenarios.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    data: text("data").notNull(), // base64 encoded
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("attachments_scenario_id_idx").on(t.scenarioId),
    check("attachments_size_check", sql`${t.size} <= 1048576`), // 1MB max
  ],
);

// K6R6-01: Recordings - raw captured data from visual recorder
export const recordings = pgTable(
  "recordings",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    startUrl: text("start_url").notNull(),
    // State: recording, completed, failed, processing
    state: text("state").notNull().default("recording"),
    // Viewport dimensions
    viewportWidth: integer("viewport_width").notNull().default(1280),
    viewportHeight: integer("viewport_height").notNull().default(720),
    // Duration in milliseconds
    durationMs: integer("duration_ms"),
    // Counts for quick display
    requestCount: integer("request_count").default(0),
    stepCount: integer("step_count").default(0),
    // Raw NDJSON capture data (stored as text, can be large)
    captureData: text("capture_data"),
    // Derived scenario (if any)
    scenarioId: text("scenario_id").references(() => scenarios.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    completedAt: timestamp("completed_at"),
  },
  (t) => [
    index("recordings_owner_id_idx").on(t.ownerId),
    index("recordings_state_idx").on(t.state),
    index("recordings_scenario_id_idx").on(t.scenarioId),
    check("recordings_state_check", sql`${t.state} IN ('recording', 'completed', 'failed', 'processing')`),
  ],
);

// K6R6-01: Scenario versions - track changes over time
export const scenarioVersions = pgTable(
  "scenario_versions",
  {
    id: text("id").primaryKey(),
    scenarioId: text("scenario_id")
      .notNull()
      .references(() => scenarios.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    // Snapshot of the graph at this version
    graph: jsonb("graph").notNull(),
    // What changed
    changeDescription: text("change_description"),
    // Source recording (if created from recording)
    sourceRecordingId: text("source_recording_id").references(() => recordings.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    index("scenario_versions_scenario_id_idx").on(t.scenarioId),
    // Unique version per scenario
    index("scenario_versions_unique_idx").on(t.scenarioId, t.version),
  ],
);

// K6R6-06: Tags for organizing scenarios
export const tags = pgTable(
  "tags",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").default("#6B7280"), // gray-500
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("tags_owner_id_idx").on(t.ownerId),
    // Unique tag name per owner
    index("tags_owner_name_idx").on(t.ownerId, t.name),
  ],
);

// K6R6-06: Scenario-Tag relationship (many-to-many)
export const scenarioTags = pgTable(
  "scenario_tags",
  {
    scenarioId: text("scenario_id")
      .notNull()
      .references(() => scenarios.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("scenario_tags_scenario_id_idx").on(t.scenarioId),
    index("scenario_tags_tag_id_idx").on(t.tagId),
  ],
);

// K6R6-06: Folders for organizing scenarios
export const folders = pgTable(
  "folders",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    parentId: text("parent_id").references((): any => folders.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("folders_owner_id_idx").on(t.ownerId),
    index("folders_parent_id_idx").on(t.parentId),
  ],
);

// K6R7-01: Browser states for session persistence
export const browserStates = pgTable(
  "browser_states",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Source: URL or scenario that created this state
    sourceUrl: text("source_url"),
    sourceScenarioId: text("source_scenario_id").references(() => scenarios.id, { onDelete: "set null" }),
    // Playwright storage state (cookies, localStorage, origins)
    storageState: jsonb("storage_state").notNull(),
    // Viewport at time of capture
    viewportWidth: integer("viewport_width").notNull().default(1280),
    viewportHeight: integer("viewport_height").notNull().default(720),
    // Expiration (auth states often expire)
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("browser_states_owner_id_idx").on(t.ownerId),
    index("browser_states_source_scenario_idx").on(t.sourceScenarioId),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type Scenario = typeof scenarios.$inferSelect;
export type NewScenario = typeof scenarios.$inferInsert;
export type Attachment = typeof attachments.$inferSelect;
export type NewAttachment = typeof attachments.$inferInsert;
export type Recording = typeof recordings.$inferSelect;
export type NewRecording = typeof recordings.$inferInsert;
export type ScenarioVersion = typeof scenarioVersions.$inferSelect;
export type NewScenarioVersion = typeof scenarioVersions.$inferInsert;
export type Tag = typeof tags.$inferSelect;
export type NewTag = typeof tags.$inferInsert;
export type Folder = typeof folders.$inferSelect;
export type NewFolder = typeof folders.$inferInsert;
export type BrowserState = typeof browserStates.$inferSelect;
export type NewBrowserState = typeof browserStates.$inferInsert;

// Run ownership tracking for orchestrator proxy
export const runOwnership = pgTable(
  "run_ownership",
  {
    runId: text("run_id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("run_ownership_user_id_idx").on(t.userId)],
);

export type RunOwnership = typeof runOwnership.$inferSelect;
export type NewRunOwnership = typeof runOwnership.$inferInsert;
