import { describe, expect, it } from "vitest";
import {
  activeRunsCount,
  applyRunsMessage,
  EMPTY_RUNS_STATE,
  parseRunsMessage,
  type ActiveRunsState,
  type RunItem,
} from "./active-runs";

const run = (id: string, status: string, extra: Partial<RunItem> = {}): RunItem => ({
  id,
  status,
  vus: 1,
  durationMs: 1000,
  createdAt: 1_700_000_000_000,
  ...extra,
});

const snapshot = (active: RunItem[], queued: RunItem[]) => ({
  version: 1,
  type: "runs.snapshot",
  active,
  queued,
});

const stateMsg = (item: RunItem, fromState: string, toState: string) => ({
  version: 1,
  type: "runs.state",
  run: item,
  fromState,
  toState,
  at: 1_700_000_001_000,
});

describe("applyRunsMessage", () => {
  it("replaces state with a snapshot", () => {
    const prev: ActiveRunsState = { active: [run("old", "running")], queued: [] };
    const next = applyRunsMessage(prev, snapshot([run("a", "running")], [run("q", "queued")]));
    expect(next.active.map((r) => r.id)).toEqual(["a"]);
    expect(next.queued.map((r) => r.id)).toEqual(["q"]);
  });

  it("adds a newly created run to active (pending) on runs.state", () => {
    const next = applyRunsMessage(EMPTY_RUNS_STATE, stateMsg(run("r1", "pending"), "", "pending"));
    expect(next.active).toEqual([run("r1", "pending")]);
    expect(next.queued).toEqual([]);
  });

  it("puts queued runs in the queued list", () => {
    const next = applyRunsMessage(EMPTY_RUNS_STATE, stateMsg(run("q1", "queued"), "", "queued"));
    expect(next.queued.map((r) => r.id)).toEqual(["q1"]);
    expect(next.active).toEqual([]);
  });

  it("moves a run from queued to active and updates it in place", () => {
    let s = applyRunsMessage(EMPTY_RUNS_STATE, snapshot([run("a", "running"), run("b", "pending")], [run("q", "queued")]));
    s = applyRunsMessage(s, stateMsg(run("q", "starting"), "queued", "starting"));
    expect(s.queued).toEqual([]);
    expect(s.active.map((r) => r.id)).toEqual(["a", "b", "q"]);
    s = applyRunsMessage(s, stateMsg(run("b", "running", { startedAt: 5 }), "pending", "running"));
    expect(s.active.map((r) => r.id)).toEqual(["a", "b", "q"]);
    expect(s.active[1]).toMatchObject({ status: "running", startedAt: 5 });
  });

  it("uses toState as the authoritative status", () => {
    const next = applyRunsMessage(EMPTY_RUNS_STATE, stateMsg(run("r", "pending"), "pending", "running"));
    expect(next.active[0].status).toBe("running");
  });

  it("removes a run on a terminal runs.state", () => {
    const s = applyRunsMessage(EMPTY_RUNS_STATE, snapshot([run("a", "running")], []));
    const next = applyRunsMessage(s, stateMsg(run("a", "finished"), "running", "finished"));
    expect(next.active).toEqual([]);
  });

  it("removes a run on runs.end from either list", () => {
    let s = applyRunsMessage(EMPTY_RUNS_STATE, snapshot([run("a", "running")], [run("q", "queued")]));
    s = applyRunsMessage(s, { version: 1, type: "runs.end", run: run("a", "failed"), status: "failed", exitCode: 1 });
    s = applyRunsMessage(s, { version: 1, type: "runs.end", run: run("q", "aborted"), status: "aborted", exitCode: 0 });
    expect(s).toEqual({ active: [], queued: [] });
  });

  it("is idempotent for duplicate events", () => {
    const msg = stateMsg(run("r", "running"), "pending", "running");
    const once = applyRunsMessage(EMPTY_RUNS_STATE, msg);
    const twice = applyRunsMessage(once, msg);
    expect(twice).toEqual(once);
  });

  it("ignores runs.end for unknown runs without changing state", () => {
    const s = applyRunsMessage(EMPTY_RUNS_STATE, snapshot([run("a", "running")], []));
    const next = applyRunsMessage(s, { version: 1, type: "runs.end", run: run("zzz", "finished"), status: "finished", exitCode: 0 });
    expect(next).toBe(s);
  });

  it("ignores unknown types, wrong versions and malformed messages", () => {
    const s = applyRunsMessage(EMPTY_RUNS_STATE, snapshot([run("a", "running")], []));
    expect(applyRunsMessage(s, { version: 1, type: "tick" })).toBe(s);
    expect(applyRunsMessage(s, { version: 2, type: "runs.snapshot", active: [], queued: [] })).toBe(s);
    expect(applyRunsMessage(s, null)).toBe(s);
    expect(applyRunsMessage(s, { version: 1, type: "runs.state" })).toBe(s);
    expect(applyRunsMessage(s, { version: 1, type: "runs.snapshot", active: "nope" })).toBe(s);
  });

  it("does not mutate the previous state", () => {
    const prev = applyRunsMessage(EMPTY_RUNS_STATE, snapshot([run("a", "running")], []));
    const frozen = JSON.parse(JSON.stringify(prev));
    applyRunsMessage(prev, stateMsg(run("b", "pending"), "", "pending"));
    applyRunsMessage(prev, { version: 1, type: "runs.end", run: run("a", "finished"), status: "finished", exitCode: 0 });
    expect(prev).toEqual(frozen);
  });

  it("accepts the REST /runs/active body as a snapshot-shaped payload", () => {
    const next = applyRunsMessage(EMPTY_RUNS_STATE, { version: 1, type: "runs.snapshot", active: [run("a", "running")], queued: [] });
    expect(activeRunsCount(next)).toBe(1);
  });
});

describe("parseRunsMessage", () => {
  it("parses JSON text and returns null for garbage", () => {
    expect(parseRunsMessage('{"version":1,"type":"runs.snapshot","active":[],"queued":[]}')).toMatchObject({ type: "runs.snapshot" });
    expect(parseRunsMessage("not json")).toBeNull();
    expect(parseRunsMessage(42 as unknown as string)).toBeNull();
  });
});

describe("activeRunsCount", () => {
  it("counts active plus queued", () => {
    expect(activeRunsCount({ active: [run("a", "running")], queued: [run("q", "queued"), run("p", "queued")] })).toBe(3);
  });
});
