import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

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
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("scenarios_owner_id_idx").on(t.ownerId)],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type Scenario = typeof scenarios.$inferSelect;
export type NewScenario = typeof scenarios.$inferInsert;
