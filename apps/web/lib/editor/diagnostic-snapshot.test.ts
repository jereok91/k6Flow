import { expect, it } from "vitest";
import {
  parseDiagnosticSnapshot,
  projectDiagnosticNodes,
  diagnosticHistoryStatus,
} from "./diagnostic-snapshot";

export const event = (
  seq: number,
  event: string,
  nodeId = "a",
  outcome = "pending",
  reason = "none",
) => ({ seq, event, nodeId, outcome, reason, elapsedMs: 0, httpStatus: 0 });

export const snapshot = (
  state = "running",
  status = "running",
  events: unknown[] = [],
) => ({
  version: 1,
  runId: "r",
  status,
  diagnostic: { nodeIds: ["a"] },
  trace: { state, events },
});

const success = [
  event(1, "enter"),
  event(2, "exit", "a", "success"),
  event(3, "complete", "", "success"),
];

it("projects only observed events and maps authoritative outcomes", () => {
  const pending = parseDiagnosticSnapshot(snapshot(), "r");
  expect(projectDiagnosticNodes(pending)).toEqual({ a: "unknown" });
  expect(
    projectDiagnosticNodes(parseDiagnosticSnapshot(
      snapshot("running", "running", [event(1, "enter")]), "r",
    )),
  ).toEqual({ a: "running" });
  expect(
    diagnosticHistoryStatus(parseDiagnosticSnapshot(
      snapshot("complete", "finished", success), "r",
    )),
  ).toBe("completed");
  const failed = [
    event(1, "enter"),
    event(2, "exit", "a", "failure", "http"),
    event(3, "complete", "", "failure", "prior-failure"),
  ];
  expect(
    diagnosticHistoryStatus(parseDiagnosticSnapshot(
      snapshot("failed", "finished", failed), "r",
    )),
  ).toBe("failed");
  expect(
    diagnosticHistoryStatus(parseDiagnosticSnapshot(
      snapshot("incomplete", "failed", success), "r",
    )),
  ).toBe("failed");
  expect(
    diagnosticHistoryStatus(parseDiagnosticSnapshot(
      snapshot("interrupted", "stopped", success), "r",
    )),
  ).toBe("stopped");
});

it.each([["stopped", "stopped"], ["aborted", "stopped"], ["errored", "failed"], ["failed", "failed"]])(
  "derives a complete trace with run status %s from the run status (%s)", (status, expected) => {
    // The parser rejects this pairing today; the mapping must still never leave a terminal unreported.
    const unparsed = { version: 1, runId: "r", status, diagnostic: { nodeIds: [] },
      trace: { state: "complete", events: [] } } as unknown as Parameters<typeof diagnosticHistoryStatus>[0];
    expect(diagnosticHistoryStatus(unparsed)).toBe(expected);
  });

// The complete-trace mapping is total: every non-finished run status must fall
// back to a terminal history status, never undefined, or a visible panel would
// never fire onTerminal. This fails if the `: "failed"` fallback is removed.
it("maps every complete trace that did not finish to a terminal history status", () => {
  for (const status of [
    "pending", "running", "queued", "starting", "stopping",
    "failed", "errored", "stopped", "aborted",
  ]) {
    const unparsed = {
      version: 1, runId: "r", status, diagnostic: { nodeIds: ["a"] },
      trace: { state: "complete", events: [] },
    } as unknown as Parameters<typeof diagnosticHistoryStatus>[0];
    expect(diagnosticHistoryStatus(unparsed)).toBe(
      status === "stopped" || status === "aborted" ? "stopped" : "failed",
    );
  }
});

it("projects skipped/failing nodes without inferring absence or completion", () => {
  const input = {
    ...snapshot(),
    diagnostic: { nodeIds: ["a", "b", "__proto__"] },
    trace: {
      state: "running",
      events: [
        event(1, "skipped", "a", "skipped", "disabled"),
        event(2, "enter", "b"),
        event(3, "exit", "b", "failure", "check"),
      ],
    },
  };
  const parsed = parseDiagnosticSnapshot(input, "r");
  expect(projectDiagnosticNodes(parsed)).toEqual({
    a: "skipped", b: "failure", ["__proto__"]: "unknown",
  });
  expect(Object.isFrozen(parsed.trace.events[0])).toBe(true);
  expect(diagnosticHistoryStatus(parsed)).toBeUndefined();
  expect(() => parseDiagnosticSnapshot(
    snapshot("failed", "running"), "r",
  )).toThrow();
  expect(() => parseDiagnosticSnapshot(
    snapshot("complete", "failed", success), "r",
  )).toThrow();
  expect(() => parseDiagnosticSnapshot(
    snapshot("running", "running", [
      event(1, "skipped", "a", "skipped", "prior-failure"),
    ]), "r",
  )).toThrow();
});

it("accepts authoritative partial terminals without fabricating events", () => {
  for (const [state, status] of [
    ["incomplete", "errored"], ["interrupted", "aborted"],
  ]) {
    const parsed = parseDiagnosticSnapshot(
      snapshot(state, status, [event(1, "enter")]), "r",
    );
    expect(parsed.trace.events).toHaveLength(1);
    expect(projectDiagnosticNodes(parsed)).toEqual({ a: "running" });
  }
  expect(() => parseDiagnosticSnapshot({
    ...snapshot(), diagnostic: { nodeIds: ["a"], private: "secret" },
  }, "r")).toThrow("Invalid diagnostic snapshot");
  expect(() => parseDiagnosticSnapshot(
    snapshot("running", "running", [{ ...event(1, "enter"), extra: 1 }]), "r",
  )).toThrow("Invalid diagnostic snapshot");
});

it("rejects identity, metadata, unknown fields, sequence and ordering errors", () => {
  for (const input of [
    { ...snapshot(), extra: 1 },
    { ...snapshot(), runId: "other" },
    snapshot("running", "running", [event(2, "enter")]),
    snapshot("running", "running", [event(1, "exit", "a", "success")]),
    snapshot("complete", "finished"),
    { ...snapshot(), diagnostic: { nodeIds: ["a", "a"] } },
    snapshot("running", "running", Array(202).fill(event(1, "enter"))),
  ]) {
    expect(() => parseDiagnosticSnapshot(input, "r")).toThrow();
  }
  expect(() => parseDiagnosticSnapshot(snapshot(), "r", ["b"])).toThrow();
  expect(() => parseDiagnosticSnapshot("x".repeat(131073), "r")).toThrow();
});

it("rejects regression and conflicting prefixes; latches terminals", () => {
  const previous = parseDiagnosticSnapshot(
    snapshot("running", "running", [event(1, "enter")]), "r",
  );
  expect(() => parseDiagnosticSnapshot(
    snapshot(), "r", undefined, previous,
  )).toThrow();
  expect(() => parseDiagnosticSnapshot(
    snapshot("running", "queued", [event(1, "enter")]), "r", undefined, previous,
  )).toThrow();
  expect(() => parseDiagnosticSnapshot(
    snapshot("running", "running", [
      event(1, "skipped", "a", "skipped", "disabled"),
    ]), "r", undefined, previous,
  )).toThrow();
  const terminal = parseDiagnosticSnapshot(
    snapshot("complete", "finished", success), "r",
  );
  expect(() => parseDiagnosticSnapshot(
    snapshot(), "r", undefined, terminal,
  )).toThrow();
});
