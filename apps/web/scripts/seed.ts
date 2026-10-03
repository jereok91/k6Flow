// K6F4-01b: explicit admin seed CLI (human-approved: NOT auto-seeded on web
// boot; init §10 secrets-via-env). Reads ADMIN_USERNAME + ADMIN_PASSWORD from
// env, upserts an `admin` user by username, and exits cleanly.
//
// Run: `pnpm --filter @k6flow/web seed` (cwd = apps/web; no env set → clean
// non-zero exit naming the missing variable, no stack dump).
//
// Note on module loading: apps/web's tsconfig does not set
// `allowImportingTsExtensions` (tsc TS5097), so relative TS imports cannot
// carry a literal `.ts` specifier; plain Node ESM, however, requires the
// explicit extension. Imports below therefore use dynamic specifiers, and a
// tiny resolve fallback (registered only when this file is the CLI entrypoint)
// lets `lib/db/client.ts`'s extension-less `./schema` import resolve under
// plain Node. Under Next.js and vitest the normal bundler resolution applies
// and the hook is never registered.
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { eq } from "drizzle-orm";

export type SeedEnvResult =
  | { ok: true; username: string; password: string }
  | { ok: false; error: string };

export function validateSeedEnv(env: Record<string, string | undefined>): SeedEnvResult {
  const username = (env.ADMIN_USERNAME ?? "").trim();
  if (username.length === 0) {
    return { ok: false, error: "Missing required environment variable: ADMIN_USERNAME" };
  }
  const password = env.ADMIN_PASSWORD ?? "";
  if (password.trim().length === 0) {
    return { ok: false, error: "Missing required environment variable: ADMIN_PASSWORD" };
  }
  if (password.length < 12) {
    return {
      ok: false,
      error: `ADMIN_PASSWORD must be at least 12 characters (got ${password.length})`,
    };
  }
  return { ok: true, username, password };
}

async function main(): Promise<void> {
  const env = validateSeedEnv(process.env);
  if (!env.ok) {
    console.error(env.error);
    process.exitCode = 1;
    return;
  }

  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (
          (specifier.startsWith("./") || specifier.startsWith("../")) &&
          !/\.[cm]?[jt]sx?$/.test(specifier)
        ) {
          return nextResolve(`${specifier}.ts`, context);
        }
        throw error;
      }
    },
  });

  const [{ getDb }, { hashPassword }, schema] = await Promise.all([
    import("../lib/db/client.ts" as string),
    import("../lib/db/password.ts" as string),
    import("../lib/db/schema.ts" as string),
  ]);

  const db = getDb();
  // Password material never reaches stdout/stderr — only username + role.
  const passwordHash = hashPassword(env.password);
  const existing = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.username, env.username))
    .limit(1);
  if (existing.length > 0) {
    await db
      .update(schema.users)
      .set({ passwordHash, role: "admin" })
      .where(eq(schema.users.id, existing[0].id));
  } else {
    await db
      .insert(schema.users)
      .values({ id: randomUUID(), username: env.username, passwordHash, role: "admin" });
  }
  console.log(`Seeded admin user "${env.username}" (role=admin).`);

  // Close the cached pg Pool (same globalThis key as lib/db/client.ts) so the
  // process exits instead of hanging on open connections.
  const pool = (globalThis as { __k6flowPool?: { end(): Promise<void> } }).__k6flowPool;
  if (pool) await pool.end();
}

const isEntrypoint =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
