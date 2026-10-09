/**
 * `useActiveRuns()` — live active/queued runs from the global runs feed
 * (`/api/ws/runs` → orchestrator `/ws/runs`, docs/api/ws-metrics.md).
 *
 * One shared socket per tab: the first subscribed component opens it and the
 * last one to unmount closes it (useSyncExternalStore over a module store),
 * so the Sidebar counter and the executions page never open two sockets.
 *
 * Connection loop:
 *   - every attempt mints a fresh `runs` ticket
 *     (`/api/orchestrator/ws-ticket?scope=runs`) and opens
 *     `${ws|wss}://${location.host}/api/ws/runs?ticket=...`;
 *   - messages are folded with the pure `applyRunsMessage` reducer;
 *   - reconnects back off 1s → 2s → … → 30s (reset once a message arrives);
 *   - when the ticket or the socket is unavailable (no message received),
 *     a single REST fetch of `/api/orchestrator/runs/active` keeps the UI
 *     populated before the next socket attempt — never a tight poll;
 *   - hidden tab ⇒ socket closed and timers cleared; visible ⇒ reconnect now.
 */

import { useSyncExternalStore } from "react";
import { applyRunsMessage, EMPTY_RUNS_STATE, parseRunsMessage, type ActiveRunsState } from "./active-runs";

export interface ActiveRunsSnapshot extends ActiveRunsState {
  /** True while the feed socket is open. */
  connected: boolean;
  /** True once any data (socket snapshot or REST fallback) was applied or attempted. */
  loaded: boolean;
  /** Increments on every `runs.end`; lets pages refresh run history. */
  endSeq: number;
}

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const TICKET_URL = "/api/orchestrator/ws-ticket?scope=runs";
const FALLBACK_URL = "/api/orchestrator/runs/active";

/** Reconnect delay for the given failed-attempt count (1s doubling, 30s cap). */
export function runsFeedBackoff(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** Math.max(0, attempt));
}

const INITIAL: ActiveRunsSnapshot = {
  ...EMPTY_RUNS_STATE,
  connected: false,
  loaded: false,
  endSeq: 0,
};

let snapshot: ActiveRunsSnapshot = INITIAL;
const listeners = new Set<() => void>();
let socket: WebSocket | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let attempt = 0;
let generation = 0;
let running = false;

function emit(next: ActiveRunsSnapshot) {
  if (next === snapshot) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

function applyMessage(msg: unknown) {
  const runs = applyRunsMessage(snapshot, msg);
  const ended = typeof msg === "object" && msg !== null && (msg as { type?: unknown }).type === "runs.end";
  if (runs === snapshot && !ended && snapshot.loaded) return;
  emit({
    ...snapshot,
    active: runs.active,
    queued: runs.queued,
    loaded: true,
    endSeq: ended ? snapshot.endSeq + 1 : snapshot.endSeq,
  });
}

function clearTimer() {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

function scheduleReconnect() {
  clearTimer();
  if (!running || document.hidden) return;
  const delay = runsFeedBackoff(attempt);
  attempt += 1;
  timer = setTimeout(() => {
    timer = null;
    void connect();
  }, delay);
}

/** One REST read used only when the socket is unavailable. */
async function restFallback(gen: number) {
  try {
    const res = await fetch(FALLBACK_URL, { cache: "no-store" });
    if (gen !== generation) return;
    if (res.ok) {
      const body = (await res.json()) as { active?: unknown; queued?: unknown };
      if (gen !== generation) return;
      applyMessage({ version: 1, type: "runs.snapshot", active: body.active ?? [], queued: body.queued ?? [] });
      return;
    }
  } catch {
    // Network error: keep the last known lists.
  }
  if (gen === generation && !snapshot.loaded) emit({ ...snapshot, loaded: true });
}

async function failAndRetry(gen: number) {
  await restFallback(gen);
  if (gen === generation) scheduleReconnect();
}

async function connect() {
  if (!running || document.hidden || socket) return;
  const gen = ++generation;

  let ticket: string | null = null;
  try {
    const res = await fetch(TICKET_URL, { cache: "no-store" });
    if (res.ok) {
      const body = (await res.json()) as { ticket?: unknown };
      ticket = typeof body.ticket === "string" ? body.ticket : null;
    }
  } catch {
    ticket = null;
  }
  if (gen !== generation) return;
  if (!ticket) {
    await failAndRetry(gen);
    return;
  }

  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  let ws: WebSocket;
  try {
    ws = new WebSocket(`${scheme}://${window.location.host}/api/ws/runs?ticket=${encodeURIComponent(ticket)}`);
  } catch {
    await failAndRetry(gen);
    return;
  }
  socket = ws;
  let received = false;

  ws.onopen = () => {
    if (gen !== generation) return;
    emit({ ...snapshot, connected: true });
  };
  ws.onmessage = (event: MessageEvent) => {
    if (gen !== generation) return;
    if (!received) {
      received = true;
      attempt = 0; // healthy feed: next drop retries quickly
    }
    applyMessage(parseRunsMessage(event.data));
  };
  ws.onclose = () => {
    if (gen !== generation) return;
    socket = null;
    emit({ ...snapshot, connected: false });
    if (received) scheduleReconnect();
    else void failAndRetry(gen);
  };
}

/** Closes the socket and cancels pending work (pause or teardown). */
function disconnect() {
  generation += 1; // invalidates in-flight fetches and socket callbacks
  clearTimer();
  if (socket) {
    const ws = socket;
    socket = null;
    ws.onopen = ws.onmessage = ws.onclose = null;
    try {
      ws.close(1000);
    } catch {
      // already closing
    }
  }
  if (snapshot.connected) emit({ ...snapshot, connected: false });
}

function onVisibilityChange() {
  if (document.hidden) {
    disconnect();
  } else {
    attempt = 0;
    void connect();
  }
}

function start() {
  running = true;
  attempt = 0;
  document.addEventListener("visibilitychange", onVisibilityChange);
  void connect();
}

function stop() {
  running = false;
  document.removeEventListener("visibilitychange", onVisibilityChange);
  disconnect();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

const getSnapshot = () => snapshot;
const getServerSnapshot = () => INITIAL;

export function useActiveRuns(): ActiveRunsSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
