import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

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
const stop = (base: string, recordingId?: string) =>
  fetch(`${base}/stop`, {
    method: "POST",
    headers: auth,
    ...(recordingId !== undefined && { body: JSON.stringify({ recordingId }) }),
  });
const captureOf = (base: string, recordingId: string, token = TOKEN) =>
  fetch(`${base}/captures/${recordingId}`, {
    ...(token !== "" && { headers: { Authorization: `Bearer ${token}` } }),
  });

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
    expect(await stopped.json()).toMatchObject({
      status: "stopped",
      recordingId: "rec-one",
      reason: "manual",
    });

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

  it("reports what a stop actually ended and serves that capture back", async () => {
    const base = await startRecorder();
    expect((await start(base, "rec-served")).status).toBe(200);

    const stopped = await stop(base, "rec-served");
    expect(stopped.status).toBe(200);
    const summary = await stopped.json();
    expect(summary).toMatchObject({ status: "stopped", recordingId: "rec-served", reason: "manual" });
    expect(summary.events).toBeGreaterThan(0);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);

    // The capture the stop reports is readable right after the answer: no reconnect,
    // no manual file hunt, and the end marker is already on disk.
    const served = await captureOf(base, summary.recordingId);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toContain("application/x-ndjson");
    const lines = (await served.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.at(-1)).toMatchObject({ type: "end", data: { reason: "manual" } });

    // Unknown and unsafe ids are not readable, and the endpoint needs the token.
    expect((await captureOf(base, "rec-never-written")).status).toBe(404);
    expect((await captureOf(base, "..%2Fmain")).status).toBe(404);
    expect((await captureOf(base, "rec-served", "")).status).toBe(401);

    // An unreadable capture answers 404: it must never take the recorder down.
    mkdirSync(join(captureDir, "rec-directory.ndjson"));
    expect((await captureOf(base, "rec-directory")).status).toBe(404);
    expect((await health(base)).status).toBe("ok");
  }, 60_000);

  it("answers duplicate stops from the one teardown they share", async () => {
    const base = await startRecorder();
    expect((await start(base, "rec-dup-stop")).status).toBe(200);

    // A client retry must not open a second teardown that closes the capture early.
    const [first, second] = await Promise.all([stop(base), stop(base)]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(await first.json()).toMatchObject({ status: "stopped", recordingId: "rec-dup-stop" });
    expect(await second.json()).toMatchObject({ status: "stopped", recordingId: "rec-dup-stop" });

    const events = captureEvents("rec-dup-stop");
    expect(events.filter((e) => e.type === "end")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "end", data: { reason: "manual" } });
  }, 60_000);

  it("answers idle when there is nothing to stop", async () => {
    const base = await startRecorder();

    const idle = await stop(base);
    expect(idle.status).toBe(200);
    expect(await idle.json()).toMatchObject({ status: "idle", recordingId: null, events: 0 });

    // A late stop for a recording that already ended still names its id, so the
    // caller can fetch the capture it never collected.
    const late = await stop(base, "rec-already-stopped");
    expect(late.status).toBe(200);
    expect(await late.json()).toMatchObject({ status: "idle", recordingId: "rec-already-stopped" });
  }, 30_000);

  it("refuses a stop aimed at another recording and keeps the live one running", async () => {
    const base = await startRecorder();
    expect((await start(base, "rec-live")).status).toBe(200);

    const refused = await stop(base, "rec-other");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "Recording mismatch", recordingId: "rec-live" });
    expect(await health(base)).toMatchObject({ recordingId: "rec-live", state: "RECORDING" });

    expect((await stop(base, "rec-live")).status).toBe(200);
    expect(await health(base)).toMatchObject({ recordingId: null, state: "idle" });
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

  it("rejects a recording id that this process already used", async () => {
    const base = await startRecorder();
    expect((await start(base, "rec-dup")).status).toBe(200);
    expect((await stop(base)).status).toBe(200);
    const again = await start(base, "rec-dup");
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "Recording id already used" });
    expect(await health(base)).toEqual({ status: "ok", recordingId: null, state: "idle", durationMs: 0 });
    // The first capture is left intact, not truncated by the rejected start.
    expect(captureEvents("rec-dup").at(-1)).toMatchObject({ type: "end", data: { reason: "manual" } });
  }, 60_000);

  it("ignores a stop sent on a previous recording's WebSocket", async () => {
    const base = await startRecorder();
    expect((await start(base, "rec-old-ws")).status).toBe(200);
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws/recordings/rec-old-ws?token=${TOKEN}`);
    await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    expect((await stop(base)).status).toBe(200);
    expect((await start(base, "rec-new-ws")).status).toBe(200);
    ws.send(JSON.stringify({ t: "stop" }));
    await sleep(1_000);
    expect(await health(base)).toMatchObject({ recordingId: "rec-new-ws", state: "RECORDING" });
    ws.close();
  }, 60_000);

  it("starts a new recording only after a concurrent stop has finished", async () => {
    const base = await startRecorder();
    expect((await start(base, "rec-c1")).status).toBe(200);
    const [stopped, started] = await Promise.all([stop(base), start(base, "rec-c2")]);
    expect(stopped.status).toBe(200);
    expect(started.status).toBe(200);
    expect(await started.json()).toEqual({ recordingId: "rec-c2", wsUrl: `/ws/recordings/rec-c2?token=${TOKEN}` });
    expect(await health(base)).toMatchObject({ recordingId: "rec-c2", state: "RECORDING" });
    const first = captureEvents("rec-c1");
    expect(first.filter((e) => e.type === "end")).toHaveLength(1);
    expect(first.at(-1)).toMatchObject({ type: "end" });
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
