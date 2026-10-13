import { expect, it } from "vitest";
import { checkEndpointTarget, isTargetAllowed, parseAllowedTargets } from "./allowlist";

const targets = parseAllowedTargets("api.example.test:443, internal.svc:8080");

it.each([undefined, "", "   ", ",,,"])("denies everything for %s", raw => {
  const empty = parseAllowedTargets(raw);
  expect(empty.malformed).toEqual([]);
  expect(isTargetAllowed(empty, "api.example.test", 443)).toBe(false);
  expect(checkEndpointTarget("https://api.example.test/x", empty, ["93.184.216.34"])).toEqual({
    allowed: false, reason: "host-not-allowed",
  });
});

it.each([
  "api.example.test",
  "api.example.test:0",
  "api.example.test:70000",
  "*.example.test:443",
  "https://api.example.test:443",
  "api.example.test:0443",
  "user@api.example.test:443",
  "api.example.test:443/path",
  "API.example.test:443",
  "api.example.test:",
])("fails closed on the malformed entry %s", entry => {
  const parsed = parseAllowedTargets(`ok.example.test:443, ${entry}`);
  expect(parsed.malformed).toEqual([entry]);
  expect(isTargetAllowed(parsed, "ok.example.test", 443)).toBe(false);
  expect(isTargetAllowed(parsed, "api.example.test", 443)).toBe(false);
  expect(checkEndpointTarget("https://ok.example.test/x", parsed, ["93.184.216.34"])).toEqual({
    allowed: false, reason: "malformed-config",
  });
});

it("matches host and port exactly", () => {
  expect(isTargetAllowed(targets, "api.example.test", 443)).toBe(true);
  expect(isTargetAllowed(targets, "internal.svc", 8080)).toBe(true);
  expect(isTargetAllowed(targets, "api.example.test", 80)).toBe(false);
  expect(isTargetAllowed(targets, "other.example.test", 443)).toBe(false);
  expect(isTargetAllowed(targets, "internal.svc.evil.test", 8080)).toBe(false);
});

it("allows a listed public host and derives the default port from the scheme", () => {
  expect(checkEndpointTarget("https://api.example.test/path?q=1", targets, ["93.184.216.34"])).toEqual({
    allowed: true, host: "api.example.test", port: 443, addresses: ["93.184.216.34"],
  });
  expect(checkEndpointTarget("http://internal.svc:8080/x", targets, ["10.0.0.5"])).toEqual({
    allowed: true, host: "internal.svc", port: 8080, addresses: ["10.0.0.5"],
  });
  // An explicit default port is the same target as the derived one.
  expect(checkEndpointTarget("https://api.example.test:443/", targets, ["93.184.216.34"])).toMatchObject({
    allowed: true, port: 443,
  });
});

it.each([
  ["ftp://api.example.test", "scheme"],
  ["file:///etc/passwd", "scheme"],
  ["https://user:pass@api.example.test/", "credentials"],
  ["https://api.example.test:8443/", "port-not-allowed"],
  ["https://other.example.test/", "host-not-allowed"],
])("denies %s as %s", (url, reason) => {
  expect(checkEndpointTarget(url, targets, ["93.184.216.34"])).toEqual({ allowed: false, reason });
});

it("denies when nothing was resolved", () => {
  expect(checkEndpointTarget("https://api.example.test/", targets, [])).toEqual({
    allowed: false, reason: "addresses-missing",
  });
});

it.each([
  "127.0.0.1", "127.1.2.3", "0.0.0.0", "255.255.255.255",
  "169.254.10.1", "169.254.169.254",
  "::1", "::", "fe80::1", "ff02::1", "fd00:ec2::254",
  "::ffff:127.0.0.1",
])("always denies the address %s even when the host is listed", address => {
  expect(checkEndpointTarget("https://api.example.test/", targets, [address])).toEqual({
    allowed: false, reason: "address-denied",
  });
  // Hosts that resolve to it are listed, so only the address rule can deny this.
  expect(checkEndpointTarget("http://internal.svc:8080/", targets, [address])).toEqual({
    allowed: false, reason: "address-denied",
  });
});

// The allow-list is the boundary: an explicitly listed host may resolve to a
// private address (the "authorized internal services" case). Addresses are only
// ever evaluated for a host that already matched an entry.
it.each([
  "10.0.0.5", "172.16.31.9", "172.32.0.1", "192.168.1.10", "100.64.0.1",
  "fc00::1", "fd12:3456::1", "::ffff:10.0.0.5",
])("allows the private address %s for an explicitly listed host", address => {
  expect(checkEndpointTarget("http://internal.svc:8080/", targets, [address])).toMatchObject({ allowed: true });
});

it("never evaluates addresses for an unlisted host", () => {
  expect(checkEndpointTarget("https://other.example.test/", targets, ["10.0.0.5"])).toEqual({
    allowed: false, reason: "host-not-allowed",
  });
});

it("allows global unicast addresses for a listed host", () => {
  expect(checkEndpointTarget("https://api.example.test/", targets, ["2606:2800:220:1:248:1893:25c8:1946"]))
    .toMatchObject({ allowed: true });
  expect(checkEndpointTarget("https://api.example.test/", targets, ["8.8.8.8", "2606:2800:220:1:248:1893:25c8:1946"]))
    .toMatchObject({ allowed: true });
});

it.each(["nope", "", "93.184.216", "1.2.3.4.5", "999.1.1.1", "fe80::1%eth0", "::ffff:999.1.1.1"])(
  "denies the unresolvable address %s", address => {
    expect(checkEndpointTarget("https://api.example.test/", targets, [address])).toEqual({
      allowed: false, reason: "address-unresolvable",
    });
  });

it("denies the whole check when any single address is denied", () => {
  expect(checkEndpointTarget("https://api.example.test/", targets, ["8.8.8.8", "127.0.0.1"])).toEqual({
    allowed: false, reason: "address-denied",
  });
});

// IPv4-mapped IPv6 has several legal spellings. Every one must reach the same
// address classification, or the denylist is bypassed by notation alone.
it.each([
  "0:0:0:0:0:ffff:127.0.0.1", "0:0:0:0:0:ffff:7f00:1", "::ffff:7f00:1",
  "::ffff:0.0.0.0", "0:0:0:0:0:ffff:a9fe:a9fe", "::ffff:169.254.169.254",
]) ("always denies the IPv4-mapped address %s", address => {
  expect(checkEndpointTarget("http://internal.svc:8080/", targets, [address])).toEqual({
    allowed: false, reason: "address-denied",
  });
});

it.each(["::ffff:10.0.0.5", "0:0:0:0:0:ffff:a00:5", "::ffff:192.168.1.10"],
)("classifies the IPv4-mapped address %s by its embedded address", address => {
  expect(checkEndpointTarget("http://internal.svc:8080/", targets, [address])).toMatchObject({ allowed: true });
});

it("classifies a mapped global address as public", () => {
  expect(checkEndpointTarget("https://api.example.test/", targets, ["::ffff:8.8.8.8"]))
    .toMatchObject({ allowed: true });
});

it("ignores a credential-only URL and treats the host case-insensitively", () => {
  expect(checkEndpointTarget("HTTPS://API.example.Test/", targets, ["93.184.216.34"])).toMatchObject({
    allowed: true, host: "api.example.test",
  });
});
