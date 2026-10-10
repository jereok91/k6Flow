import {
  diagnosticMetadataSchema,
  diagnosticEventSchema,
  DIAGNOSTIC_MAX_EVENTS,
  type DiagnosticEvent,
  type DiagnosticMetadata,
} from "@k6flow/shared";

export const DIAGNOSTIC_BODY_LIMIT = 128 * 1024;

type TraceState =
  | "pending"
  | "running"
  | "complete"
  | "failed"
  | "incomplete"
  | "interrupted";
type RunStatus =
  | "pending"
  | "running"
  | "finished"
  | "failed"
  | "stopped"
  | "queued"
  | "starting"
  | "stopping"
  | "aborted"
  | "errored";

interface Parsed {
  version: 1;
  runId: string;
  status: RunStatus;
  diagnostic: DiagnosticMetadata;
  trace: { state: TraceState; events: DiagnosticEvent[] };
}

function exactObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every(key => Object.hasOwn(value, key))
  ) {
    throw Error();
  }
  return value as Record<string, unknown>;
}

function parseEnvelope(input: unknown): Parsed {
  const data = exactObject(input, [
    "version", "runId", "status", "diagnostic", "trace",
  ]);
  const trace = exactObject(data.trace, ["state", "events"]);
  const statuses: readonly string[] = [
    "pending", "running", "finished", "failed", "stopped",
    "queued", "starting", "stopping", "aborted", "errored",
  ];
  const states: readonly string[] = [
    "pending", "running", "complete", "failed", "incomplete", "interrupted",
  ];
  if (
    data.version !== 1 ||
    typeof data.runId !== "string" ||
    !data.runId ||
    data.runId.length > 128 ||
    typeof data.status !== "string" ||
    !statuses.includes(data.status) ||
    typeof trace.state !== "string" ||
    !states.includes(trace.state) ||
    !Array.isArray(trace.events) ||
    trace.events.length > DIAGNOSTIC_MAX_EVENTS
  ) {
    throw Error();
  }
  return {
    version: 1,
    runId: data.runId,
    status: data.status as RunStatus,
    diagnostic: diagnosticMetadataSchema.parse(data.diagnostic),
    trace: {
      state: trace.state as TraceState,
      events: trace.events.map(event => diagnosticEventSchema.parse(event)),
    },
  };
}

export type DiagnosticSnapshot = Readonly<Omit<Parsed, "diagnostic" | "trace">> & {
  readonly diagnostic: { readonly nodeIds: readonly string[] };
  readonly trace: {
    readonly state: Parsed["trace"]["state"];
    readonly events: readonly Readonly<Parsed["trace"]["events"][number]>[];
  };
};

export function isDiagnosticTerminal(snapshot: DiagnosticSnapshot): boolean {
  return !["pending", "running"].includes(snapshot.trace.state);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Polls may skip transitions, but cannot move backwards through Go legalMoves.
const moves: Partial<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ["starting", "aborted", "stopped"],
  pending: ["running", "failed", "errored", "stopped"],
  starting: ["running", "errored", "aborted", "stopped"],
  running: ["stopping", "finished", "failed", "errored", "stopped", "aborted"],
  stopping: ["aborted", "finished", "failed", "errored", "stopped"],
};

function reachable(from: RunStatus, to: RunStatus): boolean {
  return from === to || (moves[from] ?? []).some(next => reachable(next, to));
}

/** Throws only a fixed safe error; no payload, Zod detail or upstream text escapes. */
export function parseDiagnosticSnapshot(
  input: unknown,
  runId: string,
  expectedIds?: readonly string[],
  previous?: DiagnosticSnapshot,
): DiagnosticSnapshot {
  try {
    if (typeof input === "string") {
      if (new TextEncoder().encode(input).byteLength > DIAGNOSTIC_BODY_LIMIT) {
        throw Error();
      }
      input = JSON.parse(input);
    } else if (
      new TextEncoder().encode(JSON.stringify(input)).byteLength >
      DIAGNOSTIC_BODY_LIMIT
    ) {
      throw Error();
    }
    const data = parseEnvelope(input);
    if (
      data.runId !== runId ||
      (expectedIds && !same(data.diagnostic.nodeIds, expectedIds))
    ) {
      throw Error();
    }
    let index = 0;
    let active = false;
    let failed = false;
    let complete = false;
    for (const [i, event] of data.trace.events.entries()) {
      if (event.seq !== i + 1 || complete) {
        throw Error();
      }
      if (event.event === "complete") {
        if (
          active ||
          index !== data.diagnostic.nodeIds.length ||
          event.outcome !== (failed ? "failure" : "success")
        ) {
          throw Error();
        }
        complete = true;
      } else {
        if (event.nodeId !== data.diagnostic.nodeIds[index]) {
          throw Error();
        }
        switch (event.event) {
          case "enter":
            if (active || failed) {
              throw Error();
            }
            active = true;
            break;
          case "exit":
            if (!active) {
              throw Error();
            }
            active = false;
            index++;
            failed ||= event.outcome === "failure";
            break;
          case "skipped":
            if (active || (event.reason === "prior-failure" && !failed)) {
              throw Error();
            }
            index++;
            break;
        }
      }
    }
    const terminalStatus = [
      "finished", "failed", "stopped", "aborted", "errored",
    ].includes(data.status);
    const interrupted = ["stopped", "aborted"].includes(data.status);
    // Mirrors Go Finish: interruption wins; invalid output is unknowable here
    // and can legitimately leave incomplete even after a completion marker.
    switch (data.trace.state) {
      case "complete":
        if (data.status !== "finished" || !complete || failed) {
          throw Error();
        }
        break;
      case "failed":
        if (!terminalStatus || interrupted || !complete || !failed) {
          throw Error();
        }
        break;
      case "interrupted":
        if (!interrupted) {
          throw Error();
        }
        break;
      case "incomplete":
        if (!terminalStatus || interrupted) {
          throw Error();
        }
        break;
      case "pending":
        if (terminalStatus || data.trace.events.length || data.status === "running") {
          throw Error();
        }
        break;
      case "running":
        if (!["running", "stopping"].includes(data.status)) {
          throw Error();
        }
        break;
    }
    if (previous) {
      if (
        !reachable(previous.status, data.status) ||
        previous.runId !== runId ||
        !same(previous.diagnostic.nodeIds, data.diagnostic.nodeIds) ||
        data.trace.events.length < previous.trace.events.length ||
        previous.trace.events.some((event, i) => !same(event, data.trace.events[i]))
      ) {
        throw Error();
      }
      if (isDiagnosticTerminal(previous)) {
        if (!same(previous, data)) {
          throw Error();
        }
        return previous;
      }
      if (previous.trace.state === "running" && data.trace.state === "pending") {
        throw Error();
      }
    }
    return Object.freeze({
      ...data,
      diagnostic: Object.freeze({ nodeIds: Object.freeze(data.diagnostic.nodeIds) }),
      trace: Object.freeze({
        state: data.trace.state,
        events: Object.freeze(data.trace.events.map(event => Object.freeze(event))),
      }),
    });
  } catch {
    throw new Error("Invalid diagnostic snapshot");
  }
}

export function diagnosticHistoryStatus(
  snapshot: DiagnosticSnapshot,
): "completed" | "failed" | "stopped" | undefined {
  switch (snapshot.trace.state) {
    case "complete":
      return snapshot.status === "finished" ? "completed" : undefined;
    case "failed":
    case "incomplete":
      return "failed";
    case "interrupted":
      return "stopped";
    default:
      return undefined;
  }
}

export type DiagnosticNodeState =
  | "unknown"
  | "running"
  | "success"
  | "failure"
  | "skipped";

export function projectDiagnosticNodes(
  snapshot: DiagnosticSnapshot,
): Readonly<Record<string, DiagnosticNodeState>> {
  const states: Record<string, DiagnosticNodeState> = Object.create(null);
  for (const id of snapshot.diagnostic.nodeIds) {
    states[id] = "unknown";
  }
  for (const event of snapshot.trace.events) {
    if (event.event === "enter") {
      states[event.nodeId] = "running";
    }
    if (event.event === "exit") {
      states[event.nodeId] = event.outcome as "success" | "failure";
    }
    if (event.event === "skipped") {
      states[event.nodeId] = "skipped";
    }
  }
  return Object.freeze(states);
}
