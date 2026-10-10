import { describe, expect, it, vi } from "vitest";
import { createSessionInvalidationHub, type SessionInvalidationIO } from "./session-invalidation";
import { mutateSession } from "./session-mutation";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(io: SessionInvalidationIO = {}) {
  const events: string[] = [];
  const hub = createSessionInvalidationHub(io);
  hub.subscribe(phase => events.push(phase));
  return { events, hub };
}

describe("production session mutation seam", () => {
  it.each([
    ["login", 200, true],
    ["login", 401, false],
    ["login", 500, false],
    ["logout", 200, true],
    ["logout", 500, true],
  ] as const)("%s response %i: synchronous begin, conditional completion, unchanged response", async (kind, status, completes) => {
    const { events, hub } = fixture();
    const pending = deferred<Response>();
    const response = new Response('{"error":"unchanged"}', { status });
    const request = vi.fn(() => {
      events.push("fetch");
      return pending.promise;
    });
    const result = mutateSession(kind, request, hub);

    // Observe immediately, without flushing microtasks: begin must precede fetch.
    expect(events).toEqual(["begin", "fetch"]);
    expect(request).toHaveBeenCalledTimes(1);
    pending.resolve(response);
    expect(await result).toBe(response);
    expect(response.bodyUsed).toBe(false);
    expect(events).toEqual(completes ? ["begin", "fetch", "complete"] : ["begin", "fetch"]);
    hub.dispose();
  });

  it.each(["login", "logout"] as const)("%s fetch rejection preserves error identity without fabricated completion/navigation", async kind => {
    const { events, hub } = fixture();
    const pending = deferred<Response>();
    const error = new Error("request failed");
    const result = mutateSession(kind, () => {
      events.push("fetch");
      return pending.promise;
    }, hub);
    const navigation = vi.fn();
    const observed = result.then(navigation);
    const synchronousEvents = [...events];
    pending.reject(error);
    await expect(observed).rejects.toBe(error);
    expect(synchronousEvents).toEqual(["begin", "fetch"]);
    expect(events).toEqual(["begin", "fetch"]);
    expect(navigation).not.toHaveBeenCalled();
    hub.dispose();
  });

  it.each(["login", "logout"] as const)("%s synchronous request throw also remains uncertain", async kind => {
    const { events, hub } = fixture();
    const error = new Error("synchronous fetch failure");
    const result = mutateSession(kind, () => {
      events.push("fetch");
      throw error;
    }, hub);
    const synchronousEvents = [...events];
    await expect(result).rejects.toBe(error);
    expect(synchronousEvents).toEqual(["begin", "fetch"]);
    expect(events).toEqual(["begin", "fetch"]);
    hub.dispose();
  });

  it.each([
    ["login", 200],
    ["logout", 200],
    ["logout", 500],
  ] as const)("%s response %i completes before the awaiting caller navigates", async (kind, status) => {
    const { events, hub } = fixture();
    const pending = deferred<Response>();
    async function caller() {
      const response = await mutateSession(kind, () => {
        events.push("fetch");
        return pending.promise;
      }, hub);
      if (kind === "logout" || response.ok) events.push("push");
    }
    const result = caller();
    expect(events).toEqual(["begin", "fetch"]);
    pending.resolve(new Response(null, { status }));
    await result;
    expect(events).toEqual(["begin", "fetch", "complete", "push"]);
    hub.dispose();
  });

  it("failed login does not complete or navigate, and leaves error parsing to the caller", async () => {
    const { events, hub } = fixture();
    const response = new Response('{"error":"Error de autenticación"}', { status: 401 });
    const result = await mutateSession("login", () => Promise.resolve(response), hub);
    if (result.ok) events.push("push");
    else expect(await result.json()).toEqual({ error: "Error de autenticación" });
    expect(events).toEqual(["begin"]);
    hub.dispose();
  });

  it("actual hub isolates listener/transport failures, preserving ordering and fixed credential-free hints", async () => {
    const events: string[] = [];
    const sent: string[] = [];
    class BrokenChannel {
      addEventListener() {}
      removeEventListener() {}
      close() {}
      postMessage(data: string) {
        events.push("channel");
        sent.push(data);
        throw new Error("channel unavailable");
      }
    }
    const hub = createSessionInvalidationHub({
      BroadcastChannel: BrokenChannel,
      localStorage: {
        setItem(_key, value) { events.push("storage"); sent.push(value); },
        removeItem() { events.push("remove"); },
      },
      addEventListener() {},
      removeEventListener() {},
    });
    hub.subscribe(() => { throw new Error("listener failed"); });
    hub.subscribe(phase => events.push(phase));
    const pending = deferred<Response>();
    const response = new Response(null, { status: 200 });
    const result = mutateSession("login", () => {
      events.push("fetch");
      return pending.promise;
    }, hub);
    expect(events).toEqual(["begin", "channel", "storage", "remove", "fetch"]);
    pending.resolve(response);
    expect(await result).toBe(response);
    expect(events).toEqual(["begin", "channel", "storage", "remove", "fetch", "complete", "storage", "remove"]);
    expect(sent).toEqual([
      "k6flow.session-invalidation.v1:begin",
      "k6flow.session-invalidation.v1:begin",
      "k6flow.session-invalidation.v1:complete",
    ]);
    hub.dispose();
  });
});
