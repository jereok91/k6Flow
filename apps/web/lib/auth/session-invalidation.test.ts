import { describe, expect, it, vi } from "vitest";
import {
  createSessionInvalidationHub, getBrowserSessionInvalidationHub,
  type SessionInvalidationIO,
} from "./session-invalidation";

const begin = "k6flow.session-invalidation.v1:begin";
const complete = "k6flow.session-invalidation.v1:complete";
const key = "k6flow.session-invalidation.v1";
const denied = () => { throw new Error("denied"); };

function peers(channel: boolean) {
  const receivers = new Set<(event: { data: unknown }) => void>();
  const storage = new Set<(event: { key: string | null; newValue: string | null }) => void>();
  const sent: unknown[] = [];
  const pulses: unknown[] = [];
  function io(): SessionInvalidationIO {
    let ownStorageListener: ((event: { key: string | null; newValue: string | null }) => void) | undefined;
    return {
      BroadcastChannel: channel ? class {
        listener?: (event: { data: unknown }) => void;
        constructor(public name: string) { expect(name).toBe(key); }
        addEventListener(_type: "message", listener: (event: { data: unknown }) => void) {
          this.listener = listener;
          receivers.add(listener);
        }
        removeEventListener(_type: "message", listener: (event: { data: unknown }) => void) {
          receivers.delete(listener);
        }
        postMessage(data: unknown) {
          sent.push(data);
          for (const receive of receivers) if (receive !== this.listener) receive({ data });
        }
        close() { if (this.listener) receivers.delete(this.listener); }
      } : undefined,
      localStorage: {
        setItem(k, value) {
          pulses.push([k, value]);
          for (const receive of storage) {
            if (receive !== ownStorageListener) receive({ key: k, newValue: value });
          }
        },
        removeItem(k) { pulses.push([k, null]); },
      },
      addEventListener(_type, listener) { ownStorageListener = listener; storage.add(listener); },
      removeEventListener(_type, listener) { storage.delete(listener); },
    };
  }
  return { io, sent, pulses, receivers, storage };
}

describe("session invalidation hints", () => {
  it("clears every local subscriber synchronously before transport despite exceptions", () => {
    const network = peers(true);
    const hub = createSessionInvalidationHub(network.io());
    const order: string[] = [];
    hub.subscribe(() => { order.push("first"); denied(); });
    let sendsDuringClear = -1;
    let pulsesDuringClear = -1;
    hub.subscribe(phase => {
      order.push(phase);
      sendsDuringClear = network.sent.length;
      pulsesDuringClear = network.pulses.length;
    });
    hub.invalidate("begin");
    expect(sendsDuringClear).toBe(0);
    expect(pulsesDuringClear).toBe(0);
    expect(order).toEqual(["first", "begin"]);
    expect(network.sent).toEqual([begin]);
    hub.dispose();
  });

  it.each([true, false])("delivers peer hints without echo (channel=%s)", channel => {
    const network = peers(channel);
    const a = createSessionInvalidationHub(network.io());
    const b = createSessionInvalidationHub(network.io());
    const phases: string[] = [];
    b.subscribe(phase => phases.push(phase));
    a.invalidate("begin");
    a.invalidate("complete");
    expect(phases).toEqual(channel ? ["begin", "begin", "complete", "complete"] : ["begin", "complete"]);
    expect(network.sent).toEqual(channel ? [begin, complete] : []);
    expect(network.pulses).toEqual([[key, begin], [key, null], [key, complete], [key, null]]);
    expect(a.getCapability()).toBe(channel ? "broadcast-channel" : "storage");
    a.dispose(); b.dispose();
    expect(network.receivers.size + network.storage.size).toBe(0);
  });

  it.each(["mixed", "channel-failure", "storage-failure"])("interoperates across three peers: %s", mode => {
    const network = peers(true);
    const senderIO = network.io();
    if (mode === "channel-failure") {
      const Base = senderIO.BroadcastChannel!;
      senderIO.BroadcastChannel = class extends Base { postMessage = denied; };
    }
    if (mode === "storage-failure") senderIO.localStorage = { setItem: denied, removeItem: denied };
    const storageIO = network.io();
    storageIO.BroadcastChannel = undefined;
    const sender = createSessionInvalidationHub(senderIO);
    const healthy = createSessionInvalidationHub(network.io());
    const storageOnly = createSessionInvalidationHub(storageIO);
    const local: string[] = [], remote: string[] = [], fallback: string[] = [];
    sender.subscribe(phase => local.push(phase));
    healthy.subscribe(phase => remote.push(phase));
    storageOnly.subscribe(phase => fallback.push(phase));
    sender.invalidate("complete"); sender.invalidate("begin");
    expect(local).toEqual(["complete", "begin"]);
    expect(remote).toEqual(mode === "mixed" ? ["complete", "complete", "begin", "begin"] : ["complete", "begin"]);
    expect(fallback).toEqual(mode === "storage-failure" ? [] : ["complete", "begin"]);
    healthy.invalidate("complete"); healthy.invalidate("begin");
    expect(local.slice(2)).toEqual(mode === "mixed" ? ["complete", "complete", "begin", "begin"] : ["complete", "begin"]);
    expect(fallback.slice(mode === "storage-failure" ? 0 : 2)).toEqual(["complete", "begin"]);
    expect(network.sent).toHaveLength(mode === "channel-failure" ? 2 : 4);
    expect(network.pulses).toHaveLength(mode === "storage-failure" ? 4 : 8);
    // Storage-only producer must also reach a healthy channel-enabled peer.
    storageOnly.invalidate("begin"); storageOnly.invalidate("complete");
    expect(remote.slice(-2)).toEqual(["begin", "complete"]);
    expect(sender.getCapability()).toBe(mode === "channel-failure" ? "storage" : "broadcast-channel");
    sender.dispose(); healthy.dispose(); storageOnly.dispose();
  });

  it("ignores malformed channel payloads including objects and throwing getters", () => {
    const network = peers(true);
    const hub = createSessionInvalidationHub(network.io());
    const phases: string[] = [];
    hub.subscribe(phase => phases.push(phase));
    const receive = [...network.receivers][0];
    for (const data of [null, {}, { phase: "complete" }, "success", `${begin}:extra`, 1]) receive({ data });
    receive({ get data() { return denied(); } });
    receive({ data: complete });
    expect(phases).toEqual(["complete"]);
    expect(network.sent).toEqual([]);
    hub.dispose();
  });

  it("ignores unrelated storage, removals, and malformed events", () => {
    const network = peers(false);
    const hub = createSessionInvalidationHub(network.io());
    const phases: string[] = [];
    hub.subscribe(phase => phases.push(phase));
    const receive = [...network.storage][0];
    receive({ key: "other", newValue: begin });
    receive({ key, newValue: null });
    receive({ key, newValue: "success" });
    receive({ get key() { return denied(); }, newValue: begin });
    receive({ key, newValue: begin });
    expect(phases).toEqual(["begin"]);
    expect(network.pulses).toEqual([]);
    hub.dispose();
  });

  it.each(["getter", "construction", "listen", "send"])("falls back when channel %s fails", failure => {
    const network = peers(false);
    const io = network.io();
    io.BroadcastChannel = class {
      constructor() { if (failure === "construction") denied(); }
      addEventListener() { if (failure === "listen") denied(); }
      removeEventListener = denied;
      close = denied;
      postMessage = denied;
    };
    if (failure === "getter") Object.defineProperty(io, "BroadcastChannel", { get: denied });
    const hub = createSessionInvalidationHub(io);
    let pulsesDuringClear = -1;
    hub.subscribe(() => { pulsesDuringClear = network.pulses.length; });
    hub.invalidate("begin");
    expect(pulsesDuringClear).toBe(0);
    expect(hub.getCapability()).toBe("storage");
    expect(network.pulses).toEqual([[key, begin], [key, null]]);
    hub.dispose();
  });

  it.each(["absent", "getter", "listen", "set", "remove"])("retains local invalidation with storage %s failure", failure => {
    const io: SessionInvalidationIO = failure === "absent" ? {} : {
      localStorage: {
        setItem() { if (failure === "set") denied(); },
        removeItem() { if (failure === "remove") denied(); },
      },
      addEventListener() { if (failure === "listen") denied(); },
      removeEventListener: denied,
    };
    Object.defineProperty(io, "BroadcastChannel", { get: denied });
    if (failure === "getter") Object.defineProperty(io, "localStorage", { get: denied });
    const hub = createSessionInvalidationHub(io);
    const phases: string[] = [];
    hub.subscribe(phase => phases.push(phase));
    hub.invalidate("begin"); hub.invalidate("complete");
    expect(phases).toEqual(["begin", "complete"]);
    expect(hub.getCapability()).toBe("local-only");
    expect(() => hub.dispose()).not.toThrow();
  });

  it("supports unsubscribe and disposal during dispatch, and rejects late events", () => {
    const network = peers(true);
    const hub = createSessionInvalidationHub(network.io());
    let calls = 0;
    const stop = hub.subscribe(() => calls++);
    stop(); stop();
    const receive = [...network.receivers][0];
    hub.subscribe(() => hub.dispose());
    hub.subscribe(() => calls++);
    hub.invalidate("begin");
    receive({ data: complete });
    hub.invalidate("complete"); hub.subscribe(() => calls++); hub.dispose();
    expect(calls).toBe(0);
    expect(network.sent).toEqual([]);
    expect(hub.getCapability()).toBe("disposed");
  });

  it("isolates remote subscriber throws and ignores unsupported local phases", () => {
    const network = peers(true);
    const hub = createSessionInvalidationHub(network.io());
    let calls = 0;
    hub.subscribe(denied);
    hub.subscribe(() => calls++);
    [...network.receivers][0]({ data: begin });
    hub.invalidate("success" as "begin");
    expect(calls).toBe(1);
    expect(network.sent).toEqual([]);
    hub.dispose();
  });

  it("guards listener method getters and removes partially registered storage listeners", () => {
    const network = peers(false);
    const io = network.io();
    const add = io.addEventListener!;
    io.addEventListener = (type, listener) => { add(type, listener); denied(); };
    Object.defineProperty(io, "BroadcastChannel", { get: denied });
    const hub = createSessionInvalidationHub(io);
    expect(network.storage.size).toBe(0);
    expect(hub.getCapability()).toBe("local-only");
    Object.defineProperty(io, "removeEventListener", { get: denied });
    expect(() => hub.dispose()).not.toThrow();
    const getterHub = createSessionInvalidationHub({
      localStorage: network.io().localStorage,
      get addEventListener() { return denied(); },
    });
    expect(getterHub.getCapability()).toBe("local-only");
    getterHub.dispose();
  });

  it("lazily shares a browser hub and recreates it after disposal", () => {
    const network = peers(true);
    vi.stubGlobal("window", network.io());
    try {
      const hub = getBrowserSessionInvalidationHub();
      expect(getBrowserSessionInvalidationHub()).toBe(hub);
      expect(hub.getCapability()).toBe("broadcast-channel");
      hub.dispose();
      const next = getBrowserSessionInvalidationHub();
      expect(next).not.toBe(hub);
      next.dispose();
    } finally { vi.unstubAllGlobals(); }
  });

  it("imports and lazily operates without browser globals in SSR", () => {
    const hub = getBrowserSessionInvalidationHub();
    let calls = 0;
    hub.subscribe(() => calls++);
    hub.invalidate("complete");
    expect(calls).toBe(1);
    expect(hub.getCapability()).toBe("local-only");
    hub.dispose();
  });
});
