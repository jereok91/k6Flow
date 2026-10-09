import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mintWsTicket, runTicketScope, wsTicketSecret, WS_TICKET_TTL_SECONDS } from "./ws-ticket";

const NOW = 1_700_000_000_000; // ms

function split(ticket: string) {
  const cut = ticket.lastIndexOf(".");
  return { signed: ticket.slice(0, cut), sig: ticket.slice(cut + 1), parts: ticket.split(".") };
}

describe("mintWsTicket", () => {
  it("produces v1.<scope>.<exp>.<nonce>.<sig> with a 60s default TTL", () => {
    const { ticket, expiresAt } = mintWsTicket("run:run-1", { secret: "s3cret", now: NOW });
    const { parts } = split(ticket);
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe("v1");
    expect(parts[1]).toBe("run:run-1");
    expect(parts[2]).toBe(String(NOW / 1000 + 60));
    expect(parts[3]).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(expiresAt).toBe(NOW + 60_000);
    expect(WS_TICKET_TTL_SECONDS).toBe(60);
  });

  it("signs the prefix with unpadded base64url HMAC-SHA256 keyed by the secret", () => {
    const { ticket } = mintWsTicket("run:run-1", { secret: "s3cret", now: NOW });
    const { signed, sig } = split(ticket);
    expect(sig).toBe(createHmac("sha256", "s3cret").update(signed).digest("base64url"));
    expect(sig).not.toContain("=");
  });

  it("matches the cross-language vector verified by the Go orchestrator", () => {
    const { ticket } = mintWsTicket("run:run-42", {
      secret: "fixture-secret",
      now: NOW,
      nonce: "AAECAwQFBgcICQoLDA0ODw",
    });
    expect(ticket).toBe(
      "v1.run:run-42.1700000060.AAECAwQFBgcICQoLDA0ODw.gXTz68PGLwUpGIZCYaGFyMGyJlRHItmua6Lg9Wmm7B4",
    );
  });

  it("honours a custom ttl and floors fractional now", () => {
    const { ticket, expiresAt } = mintWsTicket("runs", { secret: "k", now: NOW + 999, ttlSeconds: 10 });
    expect(split(ticket).parts[2]).toBe(String(NOW / 1000 + 10));
    expect(expiresAt).toBe(NOW + 10_000);
  });

  it("uses a fresh random nonce per ticket", () => {
    const a = mintWsTicket("run:x", { secret: "k", now: NOW }).ticket;
    const b = mintWsTicket("run:x", { secret: "k", now: NOW }).ticket;
    expect(split(a).parts[3]).not.toBe(split(b).parts[3]);
  });

  it("never embeds the secret in the ticket", () => {
    const { ticket } = mintWsTicket("run:x", { secret: "super-secret-service-token", now: NOW });
    expect(ticket).not.toContain("super-secret-service-token");
  });

  it("fails closed on an empty secret", () => {
    expect(() => mintWsTicket("run:x", { secret: "", now: NOW })).toThrow();
  });

  it("rejects an empty scope and a non-positive ttl", () => {
    expect(() => mintWsTicket("", { secret: "k", now: NOW })).toThrow();
    expect(() => mintWsTicket("run:x", { secret: "k", now: NOW, ttlSeconds: 0 })).toThrow();
  });
});

describe("runTicketScope", () => {
  it("scopes a ticket to one run", () => {
    expect(runTicketScope("abc")).toBe("run:abc");
  });
});

describe("wsTicketSecret", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads ORCHESTRATOR_SERVICE_TOKEN at call time", () => {
    vi.stubEnv("ORCHESTRATOR_SERVICE_TOKEN", "from-env");
    expect(wsTicketSecret()).toBe("from-env");
  });
});
