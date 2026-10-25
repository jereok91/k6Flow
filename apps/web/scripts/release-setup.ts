// K6Flow release setup: applies migrations and seeds the admin user, then exits.
//
// Runs inside the `setup` image (node --experimental-strip-types) as the first
// step of a published deployment, so a fresh database is usable without a
// checkout of the repository. Idempotent: drizzle skips applied migrations and
// the seed upserts the admin by username.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type RunSeed = (env?: Record<string, string | undefined>) => Promise<number>;

async function main(): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (typeof url !== "string" || url.trim() === "") {
    console.error("Missing required environment variable: DATABASE_URL");
    return 1;
  }

  // Dynamic specifiers: plain Node requires the extension, and apps/web's
  // tsconfig does not enable allowImportingTsExtensions (same constraint as seed.ts).
  const [orm, migrator, seed] = await Promise.all([
    import("drizzle-orm/node-postgres"),
    import("drizzle-orm/node-postgres/migrator"),
    import("./seed.ts" as string) as Promise<{ runSeed: RunSeed }>,
  ]);
  const { Pool } = await import("pg");

  const pool = new Pool({ connectionString: url });
  try {
    await migrator.migrate(orm.drizzle(pool), {
      migrationsFolder: join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "db", "migrations"),
    });
    console.log("Applied database migrations.");
  } finally {
    await pool.end();
  }

  return seed.runSeed(process.env);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
