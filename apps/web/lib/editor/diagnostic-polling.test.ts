import { afterEach, expect, it, vi } from "vitest";
import { DiagnosticObserver } from "./diagnostic-polling";

const data = {
  version: 1,
  runId: "a/b",
  status: "running",
  diagnostic: { nodeIds: ["n"] },
  trace: { state: "running", events: [] },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

it("reads immediately, serializes polls, retains last good data and erases on forbidden", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn()
    .mockResolvedValueOnce(Response.json(data))
    .mockResolvedValueOnce(new Response("private", { status: 503 }))
    .mockResolvedValueOnce(new Response(null, { status: 403 }));
  const update = vi.fn();
  const observer = new DiagnosticObserver(update, {
    fetch: fetcher, intervalMs: 10,
  });
  observer.observe("a/b");
  await vi.advanceTimersByTimeAsync(0);
  expect(fetcher.mock.calls[0][0]).toBe(
    "/api/orchestrator/runs/a%2Fb/diagnostic",
  );
  expect(observer.current.snapshot?.runId).toBe("a/b");
  await vi.advanceTimersByTimeAsync(10);
  expect(observer.current.availability).toBe("stale");
  expect(observer.current.snapshot).toBeDefined();
  await vi.advanceTimersByTimeAsync(20);
  expect(observer.current.snapshot).toBeUndefined();
  expect(observer.current.availability).toBe("forbidden");
  await vi.advanceTimersByTimeAsync(100);
  expect(fetcher).toHaveBeenCalledTimes(3);
  observer.dispose();
});

it("ignores abort-resistant A→B→A responses and unmount", async () => {
  vi.useFakeTimers();
  const releases: ((r: Response) => void)[] = [];
  const fetcher = vi.fn(() => new Promise<Response>(r => releases.push(r)));
  const observer = new DiagnosticObserver(vi.fn(), { fetch: fetcher });
  observer.observe("a/b");
  observer.observe("b");
  observer.observe("a/b");
  releases[0](Response.json(data));
  await vi.advanceTimersByTimeAsync(0);
  expect(observer.current.snapshot).toBeUndefined();
  observer.dispose();
  releases[2](Response.json(data));
  await vi.advanceTimersByTimeAsync(0);
  expect(observer.current.snapshot).toBeUndefined();
});

it("times out and retries the same run after the transport rejects on abort", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn()
    .mockImplementationOnce((_url, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    )
    .mockResolvedValue(Response.json(data));
  const observer = new DiagnosticObserver(vi.fn(), {
    fetch: fetcher, timeoutMs: 20, intervalMs: 10,
  });
  observer.observe("a/b");
  await vi.advanceTimersByTimeAsync(19);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(observer.current.availability).toBe("unavailable");
  expect(observer.current.readInFlight).toBe(false);
  expect(observer.current.readUncertain).toBe(false);
  await vi.advanceTimersByTimeAsync(20);
  expect(observer.current.snapshot).toBeDefined();
  observer.dispose();
});

it("preserves good data on invalid, regressive, missing and conflict reads; retry stays same run", async () => {
  vi.useFakeTimers();
  const enter = {
    seq: 1,
    nodeId: "n",
    event: "enter",
    elapsedMs: 0,
    httpStatus: 0,
    outcome: "pending",
    reason: "none",
  };
  const good = { ...data, trace: { state: "running", events: [enter] } };
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(good));
  const observer = new DiagnosticObserver(vi.fn(), {
    fetch: fetcher, intervalMs: 10000,
  });
  observer.observe("a/b");
  await vi.advanceTimersByTimeAsync(0);
  const original = observer.current.snapshot;
  for (const response of [
    Response.json({ invalid: true }),
    Response.json(data),
    new Response(null, { status: 404 }),
    new Response(null, { status: 409 }),
    Response.json({
      ...good,
      trace: {
        state: "running",
        events: [{
          ...enter, event: "skipped", outcome: "skipped", reason: "disabled",
        }],
      },
    }),
    new Response("x".repeat(131073)),
  ]) {
    fetcher.mockResolvedValueOnce(response);
    observer.retry();
    observer.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(observer.current.snapshot).toBe(original);
    expect(observer.current.availability).toBe("stale");
  }
  expect(fetcher).toHaveBeenCalledTimes(7);
  expect(
    fetcher.mock.calls.every(call => call[0].includes("a%2Fb/diagnostic")),
  ).toBe(true);
  observer.dispose();
});

it("does not overlap an unresolved request on manual retry or clocks", async () => {
  vi.useFakeTimers();
  let release!: (r: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(r => {
    release = r;
  }));
  const observer = new DiagnosticObserver(vi.fn(), {
    fetch: fetcher, timeoutMs: 1000, intervalMs: 10,
  });
  observer.observe("a/b");
  observer.retry();
  await vi.advanceTimersByTimeAsync(100);
  observer.retry();
  expect(fetcher).toHaveBeenCalledTimes(1);
  release(Response.json(data));
  await vi.advanceTimersByTimeAsync(0);
  observer.dispose();
});

it("singleflights stop, keeps acknowledgement nonterminal and guards old stop errors", async () => {
  vi.useFakeTimers();
  let rejectStop!: (error: Error) => void;
  const fetcher = vi.fn()
    .mockResolvedValueOnce(Response.json(data))
    .mockImplementationOnce(() => new Promise<Response>((_, reject) => {
      rejectStop = reject;
    }))
    .mockResolvedValue(Response.json(data));
  const observer = new DiagnosticObserver(vi.fn(), { fetch: fetcher });
  observer.observe("a/b");
  await vi.advanceTimersByTimeAsync(0);
  const stop = observer.stop();
  await observer.stop();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(observer.current.stopState).toBe("pending");
  observer.observe("a/b");
  rejectStop(Error("private"));
  await stop;
  await vi.advanceTimersByTimeAsync(0);
  expect(observer.current.stopState).toBeUndefined();
  fetcher.mockResolvedValueOnce(new Response(null, { status: 202 }));
  await observer.stop();
  expect(observer.current.stopState).toBe("acknowledged");
  expect(observer.current.snapshot?.trace.state).toBe("running");
  expect(fetcher.mock.calls.at(-1)?.[0]).toBe(
    "/api/orchestrator/runs/a%2Fb/stop",
  );
  observer.dispose();
});

it("captures current stop failures as fixed safe errors", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn()
    .mockResolvedValueOnce(Response.json(data))
    .mockRejectedValueOnce(Error("private upstream"));
  const observer = new DiagnosticObserver(vi.fn(), { fetch: fetcher });
  observer.observe("a/b");
  await vi.advanceTimersByTimeAsync(0);
  await observer.stop();
  expect(observer.current.stopState).toBe("error");
  expect(JSON.stringify(observer.current)).not.toContain("private");
  observer.dispose();
});

it("holds the GET transport gate after logical timeout until late headers drain", async () => {
  vi.useFakeTimers();
  const pending = deferred<Response>();
  const fetcher = vi.fn()
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue(Response.json(data));
  const observer = new DiagnosticObserver(vi.fn(), {
    fetch: fetcher, timeoutMs: 20, intervalMs: 10,
  });
  observer.observe("a/b");
  await vi.advanceTimersByTimeAsync(20);
  expect(observer.current.availability).toBe("unavailable");
  observer.retry();
  await vi.advanceTimersByTimeAsync(1000);
  observer.retry();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(observer.current).toMatchObject({
    readInFlight: true, readUncertain: true, stopInFlight: false,
  });
  expect(Object.isFrozen(observer.current)).toBe(true);

  pending.resolve(new Response(null, { status: 403 }));
  await vi.advanceTimersByTimeAsync(0);
  expect(observer.current.availability).toBe("unavailable");
  expect(observer.current).toMatchObject({
    readInFlight: false, readUncertain: false,
  });
  await vi.advanceTimersByTimeAsync(19);
  expect(fetcher).toHaveBeenCalledTimes(1);
  observer.retry();
  observer.retry();
  await vi.advanceTimersByTimeAsync(0);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(observer.current.snapshot?.runId).toBe("a/b");
  observer.dispose();
});

it("holds the Stop transport gate after timeout and returns promptly", async () => {
  vi.useFakeTimers();
  const pending = deferred<Response>();
  const fetcher = vi.fn()
    .mockResolvedValueOnce(Response.json(data))
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue(new Response(null, { status: 202 }));
  const observer = new DiagnosticObserver(vi.fn(), {
    fetch: fetcher, timeoutMs: 20, intervalMs: 10000,
  });
  observer.observe("a/b");
  await vi.advanceTimersByTimeAsync(0);
  const stop = observer.stop();
  await vi.advanceTimersByTimeAsync(20);
  await stop;
  expect(observer.current.stopState).toBe("error");
  await observer.stop();
  await vi.advanceTimersByTimeAsync(1000);
  await observer.stop();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(observer.current).toMatchObject({
    stopInFlight: true, stopUncertain: true, readInFlight: false,
  });
  pending.reject(new Error("private late transport error"));
  await vi.advanceTimersByTimeAsync(0);
  expect(observer.current).toMatchObject({
    stopInFlight: false, stopUncertain: false, stopState: "error",
  });
  expect(observer.current.snapshot?.trace.state).toBe("running");
  expect(JSON.stringify(observer.current)).not.toContain("private");
  await observer.stop();
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(observer.current.stopState).toBe("acknowledged");
  observer.dispose();
});

it("keeps a timed-out body gate until abort-resistant body cleanup settles", async () => {
  vi.useFakeTimers();
  const cancel = deferred<void>();
  const stream = new ReadableStream<Uint8Array>({ cancel: () => cancel.promise });
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(stream))
    .mockResolvedValue(Response.json(data));
  const observer = new DiagnosticObserver(vi.fn(), {
    fetch: fetcher, timeoutMs: 20, intervalMs: 10,
  });
  observer.observe("a/b");
  await vi.advanceTimersByTimeAsync(20);
  expect(observer.current.availability).toBe("unavailable");
  observer.retry();
  await vi.advanceTimersByTimeAsync(100);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(observer.current).toMatchObject({
    readInFlight: true, readUncertain: true,
  });
  cancel.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(observer.current.readInFlight).toBe(false);
  await vi.advanceTimersByTimeAsync(20);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(observer.current.snapshot).toBeDefined();
  observer.dispose();
});

it("allows simultaneous GET and Stop but not another operation of either kind", async () => {
  vi.useFakeTimers();
  const get = deferred<Response>();
  const post = deferred<Response>();
  const fetcher = vi.fn()
    .mockReturnValueOnce(get.promise)
    .mockReturnValueOnce(post.promise);
  const observer = new DiagnosticObserver(vi.fn(), {
    fetch: fetcher, timeoutMs: 20, intervalMs: 10,
  });
  observer.observe("a/b");
  const stop = observer.stop();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1][1].method).toBe("POST");
  await vi.advanceTimersByTimeAsync(20);
  await stop;
  observer.retry();
  await observer.stop();
  await vi.advanceTimersByTimeAsync(100);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(observer.current).toMatchObject({
    readInFlight: true,
    stopInFlight: true,
    readUncertain: true,
    stopUncertain: true,
  });
  get.resolve(Response.json(data));
  post.resolve(new Response(null, { status: 202 }));
  await vi.advanceTimersByTimeAsync(0);
  expect(observer.current).toMatchObject({
    readInFlight: false,
    stopInFlight: false,
    readUncertain: false,
    stopUncertain: false,
  });
  expect(observer.current.snapshot).toBeUndefined();
  expect(observer.current.stopState).toBe("error");
  observer.dispose();
});

it("does not let old-generation drain or errors reset current slots", async () => {
  vi.useFakeTimers();
  const oldA = deferred<Response>();
  const oldStop = deferred<Response>();
  const oldB = deferred<Response>();
  const newA = deferred<Response>();
  const newStop = deferred<Response>();
  const fetcher = vi.fn()
    .mockReturnValueOnce(oldA.promise)
    .mockReturnValueOnce(oldStop.promise)
    .mockReturnValueOnce(oldB.promise)
    .mockReturnValueOnce(newA.promise)
    .mockReturnValueOnce(newStop.promise);
  const update = vi.fn();
  const observer = new DiagnosticObserver(update, {
    fetch: fetcher, timeoutMs: 20, intervalMs: 10,
  });
  observer.observe("a/b");
  const stopA = observer.stop();
  await vi.advanceTimersByTimeAsync(20);
  await stopA;
  observer.observe("b");
  observer.observe("a/b");
  const stopNewA = observer.stop();
  oldA.resolve(new Response(null, { status: 403 }));
  oldB.resolve(Response.json({ ...data, runId: "b" }));
  oldStop.reject(new Error("old private error"));
  await vi.advanceTimersByTimeAsync(0);
  expect(observer.current).toMatchObject({
    runId: "a/b",
    availability: "loading",
    readInFlight: true,
    stopInFlight: true,
    readUncertain: false,
    stopUncertain: false,
  });
  observer.retry();
  await observer.stop();
  expect(fetcher).toHaveBeenCalledTimes(5);
  observer.dispose();
  const updates = update.mock.calls.length;
  newA.resolve(new Response(null, { status: 403 }));
  newStop.reject(new Error("unmounted private error"));
  await stopNewA;
  await vi.advanceTimersByTimeAsync(0);
  expect(update).toHaveBeenCalledTimes(updates);
});

it("does not report a late Stop error as a terminal execution outcome", async () => {
  vi.useFakeTimers();
  const get = deferred<Response>();
  const post = deferred<Response>();
  const fetcher = vi.fn()
    .mockReturnValueOnce(get.promise)
    .mockReturnValueOnce(post.promise);
  const observer = new DiagnosticObserver(vi.fn(), {
    fetch: fetcher, timeoutMs: 20,
  });
  observer.observe("a/b");
  const stop = observer.stop();
  get.resolve(Response.json({
    ...data,
    status: "stopped",
    trace: { state: "interrupted", events: [] },
  }));
  await vi.advanceTimersByTimeAsync(0);
  const terminal = observer.current.snapshot;
  post.reject(new Error("late private stop error"));
  await stop;
  await vi.advanceTimersByTimeAsync(0);
  expect(observer.current.snapshot).toBe(terminal);
  expect(observer.current.stopState).toBeUndefined();
  expect(observer.current.stopInFlight).toBe(false);
  await vi.advanceTimersByTimeAsync(10000);
  expect(fetcher).toHaveBeenCalledTimes(2);
  observer.dispose();
});

it("erases protected data on current Stop denial even after terminal GET", async () => {
  vi.useFakeTimers();
  const get = deferred<Response>();
  const post = deferred<Response>();
  const fetcher = vi.fn()
    .mockReturnValueOnce(get.promise)
    .mockReturnValueOnce(post.promise);
  const observer = new DiagnosticObserver(vi.fn(), { fetch: fetcher });
  observer.observe("a/b");
  const stop = observer.stop();
  get.resolve(Response.json({
    ...data,
    status: "stopped",
    trace: { state: "interrupted", events: [] },
  }));
  await vi.advanceTimersByTimeAsync(0);
  post.resolve(new Response(null, { status: 403 }));
  await stop;
  await vi.advanceTimersByTimeAsync(0);
  expect(observer.current.availability).toBe("forbidden");
  expect(observer.current.snapshot).toBeUndefined();
  expect(observer.current.stopInFlight).toBe(false);
  observer.dispose();
});

it("clears the Stop gate when the transport really rejects on abort", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn()
    .mockResolvedValueOnce(Response.json(data))
    .mockImplementationOnce((_url, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 202 }));
  const observer = new DiagnosticObserver(vi.fn(), {
    fetch: fetcher, timeoutMs: 20, intervalMs: 10000,
  });
  observer.observe("a/b");
  await vi.advanceTimersByTimeAsync(0);
  const stop = observer.stop();
  await vi.advanceTimersByTimeAsync(20);
  await stop;
  expect(observer.current).toMatchObject({
    stopState: "error", stopInFlight: false, stopUncertain: false,
  });
  await observer.stop();
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(observer.current.stopState).toBe("acknowledged");
  observer.dispose();
});

it("keeps terminal trace authority while a timed-out Stop later drains", async () => {
  vi.useFakeTimers();
  const get = deferred<Response>();
  const post = deferred<Response>();
  const fetcher = vi.fn()
    .mockReturnValueOnce(get.promise)
    .mockReturnValueOnce(post.promise);
  const observer = new DiagnosticObserver(vi.fn(), {
    fetch: fetcher, timeoutMs: 20,
  });
  observer.observe("a/b");
  const stop = observer.stop();
  get.resolve(Response.json({
    ...data,
    status: "stopped",
    trace: { state: "interrupted", events: [] },
  }));
  await vi.advanceTimersByTimeAsync(20);
  await stop;
  const terminal = observer.current.snapshot;
  expect(observer.current).toMatchObject({
    stopInFlight: true, stopUncertain: true,
  });
  expect(observer.current.stopState).toBeUndefined();
  post.reject(new Error("private post-timeout error"));
  await vi.advanceTimersByTimeAsync(0);
  expect(observer.current.snapshot).toBe(terminal);
  expect(observer.current).toMatchObject({
    stopInFlight: false, stopUncertain: false,
  });
  expect(observer.current.stopState).toBeUndefined();
  await vi.advanceTimersByTimeAsync(10000);
  expect(fetcher).toHaveBeenCalledTimes(2);
  observer.dispose();
});

it("stops polling after authoritative terminal", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockResolvedValue(Response.json({
    ...data,
    status: "stopped",
    trace: { state: "interrupted", events: [] },
  }));
  const observer = new DiagnosticObserver(vi.fn(), {
    fetch: fetcher, intervalMs: 10,
  });
  observer.observe("a/b");
  await vi.advanceTimersByTimeAsync(100);
  expect(fetcher).toHaveBeenCalledTimes(1);
  observer.retry();
  await vi.advanceTimersByTimeAsync(100);
  expect(fetcher).toHaveBeenCalledTimes(1);
  observer.dispose();
});
