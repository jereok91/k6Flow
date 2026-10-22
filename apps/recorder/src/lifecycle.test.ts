import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Integration test: runs the real recorder process with a real Chromium.
// Requires Playwright's Chromium (`npx playwright install chromium`).

const TOKEN = "test-token";
const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };

let proc: ChildProcess | null = null;
let captureDir = "";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function startRecorder(extraEnv: Record<string, string> = {}): Promise<string> {
  const port = await freePort();
  captureDir = mkdtempSync(join(tmpdir(), "recorder-test-"));
  proc = spawn(join(import.meta.dirname, "..", "node_modules", ".bin", "tsx"), ["src/main.ts"], {
    cwd: join(import.meta.dirname, ".."),
    env: { ...process.env, PORT: String(port), AUTH_TOKEN: TOKEN, CAPTURE_DIR: captureDir, START_URL: "about:blank", ...extraEnv },
    stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return base;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("recorder did not start");
}

function exited(p: ChildProcess, ms: number): Promise<number | null | "running"> {
  if (p.exitCode !== null) return Promise.resolve(p.exitCode);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve("running"), ms);
    p.once("exit", (code) => { clearTimeout(t); resolve(code); });
  });
}

const health = async (base: string) => (await fetch(`${base}/healthz`)).json();
const start = (base: string, recordingId: string, startUrl = "about:blank") =>
  fetch(`${base}/start`, { method: "POST", headers: auth, body: JSON.stringify({ recordingId, startUrl }) });
const captureEvents = (id: string) =>
  readFileSync(join(captureDir, `${id}.ndjson`), "utf8").trim().split("\n").map((line) => JSON.parse(line));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Commands of every process descended from `pid` (Linux `ps`).
function descendants(pid: number): string[] {
  const rows = execFileSync("ps", ["-eo", "pid=,ppid=,comm="], { encoding: "utf8" })
    .trim().split("\n").map((l) => l.trim().split(/\s+/));
  const found: string[] = [];
  const queue = [String(pid)];
  while (queue.length) {
    const parent = queue.shift();
    for (const [child, ppid, comm] of rows) {
      if (ppid === parent) { found.push(comm); queue.push(child); }
    }
  }
  return found;
}
const chromeCount = (pid: number) => descendants(pid).filter((c) => /chrom|headless_shell/i.test(c)).length;
const stop = (base: string) => fetch(`${base}/stop`, { method: "POST", headers: auth });

afterEach(async () => {
  if (proc && proc.exitCode === null) {
    proc.kill("SIGKILL");
    await exited(proc, 5000);
  }
  proc = null;
  if (captureDir) rmSync(captureDir, { recursive: true, force: true });
});

describe("recorder lifecycle", () => {
  it("stays alive after a stopped recording and accepts a new one", async () => {
    const base = await startRecorder();

    expect((await start(base, "rec-one")).status).toBe(200);
    expect((await health(base)).state).toBe("RECORDING");
    const stopped = await stop(base);
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toEqual({ status: "stopped" });

    // Past the former 1s exit delay, the process must still be serving.
    expect(await exited(proc!, 2000)).toBe("running");
    expect(await health(base)).toEqual({ status: "ok", recordingId: null, state: "idle", durationMs: 0 });

    // A second recording is a fresh session, not a "reconnected" stale one.
    const second = await start(base, "rec-two");
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ recordingId: "rec-two", wsUrl: `/ws/recordings/rec-two?token=${TOKEN}` });
    expect((await health(base)).recordingId).toBe("rec-two");
    expect((await stop(base)).status).toBe(200);

    // Each recording still writes its capture exactly once.
    expect(readdirSync(captureDir).sort()).toEqual(["rec-one.ndjson", "rec-two.ndjson"]);
  }, 60_000);

  it("rejects stop without the token and keeps recording", async () => {
    const base = await startRecorder();
    expect((await start(base, "rec-auth")).status).toBe(200);
    const res = await fetch(`${base}/stop`, { method: "POST" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect((await health(base)).state).toBe("RECORDING");
  }, 60_000);

  it("still exits cleanly on SIGTERM", async () => {
    await startRecorder();
    proc!.kill("SIGTERM");
    expect(await exited(proc!, 10_000)).toBe(0);
  }, 30_000);

  it("ends the in-flight capture and exits 0 on SIGTERM during a recording", async () => {
    const base = await startRecorder();
    expect((await start(base, "rec-term")).status).toBe(200);
    proc!.kill("SIGTERM");
    expect(await exited(proc!, 10_000)).toBe(0);
    const events = captureEvents("rec-term");
    expect(events.filter((e) => e.type === "end")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "end", data: { reason: "sigterm" } });
  }, 30_000);

  it("recovers from a failed start so the next start is a fresh session", async () => {
    const base = await startRecorder();
    const failed = await start(base, "rec-bad", "http://127.0.0.1:1/");
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "Failed to start recording" });
    expect(await health(base)).toEqual({ status: "ok", recordingId: null, state: "idle", durationMs: 0 });
    // The failed attempt's browser must not be left running.
    await sleep(500);
    expect(chromeCount(proc!.pid!)).toBe(0);

    const next = await start(base, "rec-good");
    expect(next.status).toBe(200);
    expect(await next.json()).toEqual({ recordingId: "rec-good", wsUrl: `/ws/recordings/rec-good?token=${TOKEN}` });
    expect(await health(base)).toMatchObject({ recordingId: "rec-good", state: "RECORDING" });
    expect(chromeCount(proc!.pid!)).toBeGreaterThan(0); // sanity: the helper sees live browsers
  }, 60_000);

  it("does not carry the previous recording's idle time into a new one", async () => {
    // Inactivity is checked every 10s; 12s window: stale idle (8s + 10s) would exceed it.
    const base = await startRecorder({ INACTIVITY_MS: "12000" });
    expect((await start(base, "rec-old")).status).toBe(200);
    expect((await stop(base)).status).toBe(200);
    await sleep(8_000);
    expect((await start(base, "rec-new")).status).toBe(200);
    await sleep(10_500);
    expect(await health(base)).toMatchObject({ recordingId: "rec-new", state: "RECORDING" });
  }, 60_000);
});
