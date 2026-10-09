import { describe, expect, it } from "vitest";
import { AsyncLifetime } from "./async-lifetime";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("async lifetime", () => {
  it("rejects work before setup and after cleanup, and survives StrictMode replay", () => {
    const lifetime = new AsyncLifetime();
    expect(lifetime.isCurrent(lifetime.capture())).toBe(false);
    lifetime.mount();
    const first = lifetime.capture();
    expect(lifetime.isCurrent(first)).toBe(true);
    lifetime.unmount();
    expect(lifetime.isCurrent(first)).toBe(false);
    lifetime.mount();
    expect(lifetime.isCurrent(first)).toBe(false);
    expect(lifetime.isCurrent(lifetime.capture())).toBe(true);
  });

  it("suppresses a page continuation even if the hook already returned saved", async () => {
    const lifetime = new AsyncLifetime();
    lifetime.mount();
    const ticket = lifetime.capture();
    const saved = deferred<string>();
    const effects: string[] = [];
    const continuation = saved.promise.then(result => {
      if (lifetime.isCurrent(ticket)) effects.push(result, "baseline", "dialog", "navigation");
    });
    saved.resolve("success toast");
    lifetime.unmount();
    await continuation;
    expect(effects).toEqual([]);
  });

  it.each(["resolve", "reject"] as const)("isolates stop %s and finally across A -> B -> A", async outcome => {
    const lifetime = new AsyncLifetime();
    lifetime.mount(); // run A
    const ticket = lifetime.capture();
    const stop = deferred<void>();
    const state = { pending: true, error: "" };
    const completion = (async () => {
      try {
        await stop.promise;
        if (lifetime.isCurrent(ticket)) state.pending = false;
      } catch {
        if (lifetime.isCurrent(ticket)) state.error = "A failed";
      } finally {
        if (lifetime.isCurrent(ticket)) state.pending = false;
      }
    })();
    lifetime.unmount();
    lifetime.mount(); // run B
    lifetime.unmount();
    lifetime.mount(); // a new run A session, not the old A
    state.pending = true;
    outcome === "resolve" ? stop.resolve() : stop.reject(new Error("late failure"));
    await completion;
    expect(state).toEqual({ pending: true, error: "" });
  });

  it.each(["resolve", "reject"] as const)("allows current-session %s and finally continuations", async outcome => {
    const lifetime = new AsyncLifetime();
    lifetime.mount();
    const ticket = lifetime.capture();
    const request = deferred<void>();
    const effects: string[] = [];
    const completion = (async () => {
      try {
        await request.promise;
        if (lifetime.isCurrent(ticket)) effects.push("success");
      } catch {
        if (lifetime.isCurrent(ticket)) effects.push("error");
      } finally {
        if (lifetime.isCurrent(ticket)) effects.push("finally");
      }
    })();
    outcome === "resolve" ? request.resolve() : request.reject(new Error("current failure"));
    await completion;
    expect(effects).toEqual([outcome === "resolve" ? "success" : "error", "finally"]);
  });

  it("keeps page-wide requests valid when only the flow is replaced", () => {
    const page = new AsyncLifetime();
    const flow = new AsyncLifetime();
    page.mount();
    flow.mount();
    const history = page.capture();
    const save = flow.capture();
    flow.invalidate();
    expect(page.isCurrent(history)).toBe(true);
    expect(flow.isCurrent(save)).toBe(false);
    page.unmount();
    flow.unmount();
    expect(page.isCurrent(history)).toBe(false);
  });

  it("invalidates replaced-flow work without ending the mounted lifetime", () => {
    const lifetime = new AsyncLifetime();
    lifetime.mount();
    const old = lifetime.capture();
    lifetime.invalidate();
    expect(lifetime.isCurrent(old)).toBe(false);
    expect(lifetime.isCurrent(lifetime.capture())).toBe(true);
  });

  it.each(["resolve", "reject"] as const)("suppresses stop %s/catch/finally after unmount", async outcome => {
    const lifetime = new AsyncLifetime();
    lifetime.mount();
    const ticket = lifetime.capture();
    const stop = deferred<void>();
    const effects: string[] = [];
    const completion = (async () => {
      try {
        await stop.promise;
        if (lifetime.isCurrent(ticket)) effects.push("success");
      } catch {
        if (lifetime.isCurrent(ticket)) effects.push("error");
      } finally {
        if (lifetime.isCurrent(ticket)) effects.push("pending");
      }
    })();
    lifetime.unmount();
    outcome === "resolve" ? stop.resolve() : stop.reject(new Error("late failure"));
    await completion;
    expect(effects).toEqual([]);
  });
});
