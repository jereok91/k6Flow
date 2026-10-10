import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sessions, users, type User } from "../../../../lib/db/schema";
import { SESSION_COOKIE } from "../../../../lib/auth/cookie";
import { getSessionUser, revokeSession } from "../../../../lib/auth/session";
import { requireUser } from "../../../../lib/auth/require-user";
import { GET } from "./route";

const dbState = vi.hoisted(() => ({
  tokens: new Map<string, { userId: string; expiresAt: Date }>(),
  users: new Map<string, unknown>(),
  reads: [] as unknown[],
  failure: false,
  deleteFailure: false,
}));

vi.mock("drizzle-orm", async (importOriginal) => ({
  ...await importOriginal<typeof import("drizzle-orm")>(),
  eq: (column: unknown, value: string) => ({ column, value }),
}));
vi.mock("../../../../lib/db/client", () => ({
  getDb: () => {
    if (dbState.failure) throw new Error("private database detail");
    return {
      select: () => ({
        from: (table: unknown) => ({
          where: ({ value }: { value: string }) => ({
            limit: async () => {
              dbState.reads.push(table);
              const row = table === sessions ? dbState.tokens.get(value) : dbState.users.get(value);
              return row ? [row] : [];
            },
          }),
        }),
      }),
      delete: () => ({
        where: async ({ value }: { value: string }) => {
          if (dbState.deleteFailure) throw new Error("private delete detail");
          dbState.tokens.delete(value);
        },
      }),
    };
  },
}));

const tokenA = "a".repeat(43);
const tokenB = "b".repeat(43);
const row: User = {
  id: "u1", username: "alice", role: "user",
  createdAt: new Date("2026-01-01T00:00:00Z"), passwordHash: "private-password-hash",
};
const safeUser = { id: row.id, username: row.username, role: row.role, createdAt: row.createdAt };
const markerFor = (token: string) => createHash("sha256")
  .update(`k6flow.session-marker.v1\0${token}`).digest("hex");
const probe = (token?: string, authorization?: string) => GET(new Request("http://localhost/api/auth/me", {
  headers: {
    ...(token === undefined ? {} : { cookie: `${SESSION_COOKIE}=${token}` }),
    ...(authorization ? { authorization } : {}),
  },
}));

beforeEach(() => {
  dbState.tokens.clear();
  dbState.users.clear();
  dbState.reads = [];
  dbState.failure = false;
  dbState.deleteFailure = false;
  dbState.tokens.set(tokenA, { userId: row.id, expiresAt: new Date(Date.now() + 60_000) });
  dbState.users.set(row.id, row);
});

async function expectDenied(response: Response, status = 401) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json();
  expect(body).toEqual({ error: status === 401 ? "Unauthorized" : "Internal server error" });
  expect(body).not.toHaveProperty("sessionMarker");
}

describe("authenticated session marker probe", () => {
  it("keeps top-level SafeUser fields and adds the exact full domain-separated marker", async () => {
    const response = await probe(tokenA);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ...safeUser, createdAt: row.createdAt.toISOString(), sessionMarker: markerFor(tokenA),
    });
    expect(markerFor(tokenA)).toMatch(/^[a-f0-9]{64}$/);
    expect(dbState.reads).toEqual([sessions, users]);
  });

  it("is stable for a live token but changes for a new login by the same user", async () => {
    dbState.tokens.set(tokenB, { userId: row.id, expiresAt: new Date(Date.now() + 60_000) });
    const first = await (await probe(tokenA)).json();
    const repeat = await (await probe(tokenA)).json();
    const next = await (await probe(tokenB)).json();
    expect(first.sessionMarker).toBe(markerFor(tokenA));
    expect(repeat).toEqual(first);
    expect(next.id).toBe(first.id);
    expect(next.sessionMarker).toBe(markerFor(tokenB));
    expect(next.sessionMarker).not.toBe(first.sessionMarker);
  });

  it("pairs the marker with the user from that same token resolution", async () => {
    const other = { ...row, id: "u2", username: "bob", role: "admin" };
    dbState.users.set(other.id, other);
    dbState.tokens.set(tokenB, { userId: other.id, expiresAt: new Date(Date.now() + 60_000) });
    const body = await (await probe(tokenB)).json();
    expect(body.id).toBe(other.id);
    expect(body.username).toBe(other.username);
    expect(body.sessionMarker).toBe(markerFor(tokenB));
    expect(dbState.reads).toEqual([sessions, users]);
  });

  it.each([undefined, "", "%broken", "unknown-token"])("fails closed for missing/malformed/unknown cookie %s", async (token) => {
    await expectDenied(await probe(token));
    expect(dbState.reads).not.toContain(users);
  });

  it("rejects expired sessions and removes the expired row", async () => {
    dbState.tokens.set(tokenA, { userId: row.id, expiresAt: new Date(Date.now() - 1) });
    await expectDenied(await probe(tokenA));
    expect(dbState.tokens.has(tokenA)).toBe(false);
    expect(dbState.reads).toEqual([sessions]);
  });

  it("rejects revoked sessions", async () => {
    await revokeSession(tokenA);
    await expectDenied(await probe(tokenA));
  });

  it("rejects a session whose user no longer exists", async () => {
    dbState.users.clear();
    await expectDenied(await probe(tokenA));
  });

  it("never accepts a derived marker as a cookie or bearer credential", async () => {
    const marker = (await (await probe(tokenA)).json()).sessionMarker;
    expect(marker).toBe(markerFor(tokenA));
    await expectDenied(await probe(marker));
    await expectDenied(await probe(undefined, `Bearer ${marker}`));
    expect(await requireUser(`${SESSION_COOKIE}=${marker}`)).toBeNull();
    expect(await getSessionUser(marker)).toBeNull();
  });

  it("returns generic no-store 500 on database failure without logging credentials", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      dbState.failure = true;
      await expectDenied(await probe(tokenA), 500);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("preserves the existing 500 policy for an expired-row delete failure", async () => {
    dbState.tokens.set(tokenA, { userId: row.id, expiresAt: new Date(0) });
    dbState.deleteFailure = true;
    await expectDenied(await probe(tokenA), 500);
  });

  it("does not disclose raw tokens or password hashes in successful responses", async () => {
    const response = await probe(tokenA);
    const text = await response.text();
    expect(text).not.toContain(tokenA);
    expect(text).not.toContain(row.passwordHash);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(JSON.parse(text)).not.toHaveProperty("token");
  });

  it("preserves legacy user-only resolver contracts", async () => {
    expect(await getSessionUser(tokenA)).toEqual(safeUser);
    expect(await requireUser(`${SESSION_COOKIE}=${tokenA}`)).toEqual(safeUser);
    expect(await requireUser(null)).toBeNull();
  });
});
