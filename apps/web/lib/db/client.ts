import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

// Cache on globalThis so Next.js dev HMR re-evaluation does not create
// additional pg Pools and exhaust Postgres connections.
const globalForDb = globalThis as unknown as { __k6flowPool?: Pool; __k6flowDb?: Db };

export function getDb(): Db {
  if (!globalForDb.__k6flowDb) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "DATABASE_URL is not set. Provide a PostgreSQL connection string (e.g. postgresql://user:pass@host:5432/db) before using the database.",
      );
    }
    globalForDb.__k6flowPool = new Pool({ connectionString: url });
    globalForDb.__k6flowDb = drizzle(globalForDb.__k6flowPool, { schema });
  }
  return globalForDb.__k6flowDb;
}
