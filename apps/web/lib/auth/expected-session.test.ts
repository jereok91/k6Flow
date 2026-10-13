import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ identity: vi.fn() }));
vi.mock("./require-user", () => ({ requireSessionIdentity: mocks.identity }));
import { checkExpectedSession, expectedSessionFailure, SESSION_MARKER_HEADER } from "./expected-session";

const COOKIE = "k6flow_session=cookie-secret-token";
const LIVE = "a".repeat(64);
const OTHER = "b".repeat(64);
const user = { id: "u1", username: "bob", role: "user" as const, createdAt: new Date(0) };

const request = (marker?: string) => {
  const headers = new Headers({ cookie: COOKIE });
  if (marker !== undefined) headers.set(SESSION_MARKER_HEADER, marker);
  return new Request("http://localhost/api", { headers });
};

async function expectSafeFailure(marker: string | undefined, status: 401 | 412 | 503, error: string) {
  const result = await checkExpectedSession(request(marker));
  expect(result).toEqual({ ok: false, status });
  if (result.ok) return;
  const response = expectedSessionFailure(result.status);
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const text = await response.text();
  expect(JSON.parse(text)).toEqual({ error });
  for (const secret of [LIVE, OTHER, COOKIE, "cookie-secret-token"]) expect(text).not.toContain(secret);
}

describe("checkExpectedSession", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns 401 without a live session", async () => {
    mocks.identity.mockResolvedValue(null);
    await expectSafeFailure(LIVE, 401, "Unauthorized");
    expect(mocks.identity).toHaveBeenCalledWith(COOKIE);
  });

  it.each([
    ["missing", undefined],
    ["uppercase", "A".repeat(64)],
    ["short", "a".repeat(63)],
    ["long", "a".repeat(65)],
    ["non-hex", "g".repeat(64)],
    ["mismatched", OTHER],
  ])("returns 412 for a %s marker", async (_kind, marker) => {
    mocks.identity.mockResolvedValue({ user, sessionMarker: LIVE });
    await expectSafeFailure(marker, 412, "Session changed");
  });

  it("returns a generic 503 when the session lookup throws", async () => {
    mocks.identity.mockRejectedValue(new Error(`Failed query\nparams: cookie-secret-token,${LIVE},${OTHER}`));
    await expectSafeFailure(LIVE, 503, "Session check unavailable");
  });

  it("returns the identity when the marker matches", async () => {
    const identity = { user, sessionMarker: LIVE };
    mocks.identity.mockResolvedValue(identity);
    expect(await checkExpectedSession(request(LIVE))).toEqual({ ok: true, identity });
  });
});
