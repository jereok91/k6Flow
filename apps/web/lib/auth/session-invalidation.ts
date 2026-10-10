export type SessionInvalidationPhase = "begin" | "complete";
type MessageListener = (event: { data: unknown }) => void;
type StorageListener = (event: { key: string | null; newValue: string | null }) => void;
interface Channel {
  addEventListener(type: "message", listener: MessageListener): void;
  removeEventListener(type: "message", listener: MessageListener): void;
  postMessage(data: string): void;
  close(): void;
}
export interface SessionInvalidationIO {
  BroadcastChannel?: new (name: string) => Channel;
  localStorage?: Pick<Storage, "setItem" | "removeItem">;
  addEventListener?: (type: "storage", listener: StorageListener) => void;
  removeEventListener?: (type: "storage", listener: StorageListener) => void;
}
export type SessionInvalidationCapability = "broadcast-channel" | "storage" | "local-only" | "disposed";
const key = "k6flow.session-invalidation.v1";
const messages = { begin: `${key}:begin`, complete: `${key}:complete` } as const;
const quietly = (action: () => void) => { try { action(); } catch { /* Best effort, no payload logging. */ } };

// Hints only: neither a remote message nor completion establishes authentication.
// Both transports carry the same hint: duplicate remote callbacks are intentional.
// Consumers must treat them as idempotent privacy invalidation, never auth state.
export function createSessionInvalidationHub(io: SessionInvalidationIO = {}) {
  let disposed = false;
  let channel: Channel | undefined;
  let storage: SessionInvalidationIO["localStorage"];
  let storageListening = false;
  const listeners = new Set<(phase: SessionInvalidationPhase) => void>();

  function notify(phase: SessionInvalidationPhase) {
    for (const listener of [...listeners]) {
      if (disposed) break;
      if (listeners.has(listener)) quietly(() => listener(phase));
    }
  }
  function receive(data: unknown) {
    if (disposed) return;
    if (data === messages.begin) notify("begin");
    else if (data === messages.complete) notify("complete");
  }
  const onMessage: MessageListener = event => quietly(() => receive(event.data));
  const onStorage: StorageListener = event => quietly(() => {
    if (event.key === key) receive(event.newValue);
  });

  function dropChannel() {
    const old = channel;
    channel = undefined;
    if (old) {
      quietly(() => old.removeEventListener("message", onMessage));
      quietly(() => old.close());
    }
  }
  function dropStorage() {
    storage = undefined;
    if (storageListening) quietly(() => io.removeEventListener?.("storage", onStorage));
    storageListening = false;
  }
  function useStorage() {
    try {
      const candidate = io.localStorage;
      if (!candidate || !io.addEventListener || !io.removeEventListener) return;
      // Mark first so a listener that registers and then throws can be removed.
      storageListening = true;
      io.addEventListener("storage", onStorage);
      storage = candidate;
    } catch { dropStorage(); }
  }
  try {
    const Constructor = io.BroadcastChannel;
    if (Constructor) {
      channel = new Constructor(key);
      channel.addEventListener("message", onMessage);
    }
  } catch { dropChannel(); }
  useStorage();

  return {
    subscribe(listener: (phase: SessionInvalidationPhase) => void) {
      if (!disposed) listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    invalidate(phase: SessionInvalidationPhase) {
      if (disposed || (phase !== "begin" && phase !== "complete")) return;
      // Privacy callbacks run before any external IO, even when sending fails.
      notify(phase);
      if (disposed) return;
      if (channel) {
        try { channel.postMessage(messages[phase]); }
        catch { dropChannel(); }
      }
      if (disposed || !storage) return;
      const target = storage;
      let failed = false;
      try { target.setItem(key, messages[phase]); } catch { failed = true; }
      try { target.removeItem(key); } catch { failed = true; }
      if (failed) dropStorage();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      dropChannel();
      dropStorage();
    },
    // Preferred usable transport, not a cross-tab delivery guarantee.
    getCapability(): SessionInvalidationCapability {
      if (disposed) return "disposed";
      return channel ? "broadcast-channel" : storage ? "storage" : "local-only";
    },
  };
}

export type SessionInvalidationHub = ReturnType<typeof createSessionInvalidationHub>;
let browserHub: SessionInvalidationHub | undefined;

// No browser access at import time; SSR callers receive isolated local hubs.
export function getBrowserSessionInvalidationHub(): SessionInvalidationHub {
  try {
    if (typeof window !== "undefined") {
      if (!browserHub || browserHub.getCapability() === "disposed") {
        browserHub = createSessionInvalidationHub(window as unknown as SessionInvalidationIO);
      }
      return browserHub;
    }
  } catch { /* A denied browser global still permits local invalidation. */ }
  return createSessionInvalidationHub();
}
