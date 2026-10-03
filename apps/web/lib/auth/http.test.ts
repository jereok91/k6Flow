import { describe, expect, it } from "vitest";
import { jsonError, parseLoginBody } from "./http";

// K6F4-02a: pure JSON helpers shared by the 02b route handlers.

describe("jsonError (K6F4-02a)", () => {
  it("returns a JSON Response with the given status and a consistent body shape", async () => {
    const res = jsonError(401, "Invalid credentials");
    expect(res.status).toBe(401);
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    await expect(res.json()).resolves.toEqual({ error: "Invalid credentials" });
  });
});

describe("parseLoginBody (K6F4-02a)", () => {
  it("accepts a valid body", () => {
    expect(parseLoginBody(JSON.stringify({ username: "alice", password: "hunter2" }))).toEqual({
      ok: true,
      username: "alice",
      password: "hunter2",
    });
  });

  it("rejects missing or non-JSON bodies", () => {
    expect(parseLoginBody("")).toEqual({ ok: false, error: "Invalid JSON body" });
    expect(parseLoginBody("not json")).toEqual({ ok: false, error: "Invalid JSON body" });
  });

  it("rejects non-object bodies (array, string, number, null, boolean)", () => {
    for (const body of ['["alice"]', '"alice"', "42", "null", "true"]) {
      expect(parseLoginBody(body)).toEqual({ ok: false, error: "Body must be a JSON object" });
    }
  });

  it("rejects missing, blank, or non-string username", () => {
    const cases: string[] = [
      JSON.stringify({ password: "x" }),
      JSON.stringify({ username: "   ", password: "x" }),
      JSON.stringify({ username: 7, password: "x" }),
      JSON.stringify({ username: null, password: "x" }),
    ];
    for (const body of cases) {
      expect(parseLoginBody(body)).toEqual({
        ok: false,
        error: "username must be a non-blank string",
      });
    }
  });

  it("rejects missing, blank, or non-string password", () => {
    const cases: string[] = [
      JSON.stringify({ username: "alice" }),
      JSON.stringify({ username: "alice", password: "  " }),
      JSON.stringify({ username: "alice", password: 9 }),
    ];
    for (const body of cases) {
      expect(parseLoginBody(body)).toEqual({
        ok: false,
        error: "password must be a non-blank string",
      });
    }
  });
});
