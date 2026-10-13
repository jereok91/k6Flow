import { isIP } from "node:net";

// Pure target guard for the endpoint test executor. It performs no I/O: the
// caller resolves DNS and passes the addresses, so this stays deterministic and
// the allow-list remains the only authority on what may be contacted.

export interface AllowedTargets {
  /** Lowercase `host:port` entries. Empty means deny everything. */
  readonly entries: ReadonlySet<string>;
  /** Malformed config entries; when non-empty the list denies everything. */
  readonly malformed: readonly string[];
}

export type TargetDenialReason =
  | "malformed-config"
  | "url-invalid"
  | "scheme"
  | "credentials"
  | "host-not-allowed"
  | "port-not-allowed"
  | "addresses-missing"
  | "address-denied"
  | "address-unresolvable";

export type TargetCheck =
  | { allowed: true; host: string; port: number; addresses: readonly string[] }
  | { allowed: false; reason: TargetDenialReason };

/** Lowercase ASCII host: one or more dot-separated labels, no wildcard. */
const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
/** No leading zeros, so `0443` is config noise rather than a port. */
const PORT_PATTERN = /^[1-9]\d{0,4}$/;
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Parses the allow-list. Any malformed entry makes the whole list deny
 * everything: a broken config must never grant access by omission.
 */
export function parseAllowedTargets(raw: string | undefined): AllowedTargets {
  const malformed: string[] = [];
  const entries = new Set<string>();
  for (const candidate of (raw ?? "").split(",")) {
    const entry = candidate.trim();
    if (!entry) continue;
    if (isValidEntry(entry)) entries.add(entry);
    else malformed.push(entry);
  }
  return Object.freeze({
    entries: malformed.length > 0 ? new Set<string>() : entries,
    malformed: Object.freeze(malformed),
  });
}

export function isTargetAllowed(targets: AllowedTargets, host: string, port: number): boolean {
  return targets.entries.has(`${host.toLowerCase()}:${port}`);
}

/** Validates one URL against the allow-list and its resolved addresses. */
export function checkEndpointTarget(
  url: string,
  targets: AllowedTargets,
  resolvedAddresses: readonly string[],
): TargetCheck {
  if (targets.malformed.length > 0) return deny("malformed-config");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return deny("url-invalid");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return deny("scheme");
  if (parsed.username || parsed.password) return deny("credentials");
  const host = parsed.hostname.toLowerCase();
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return deny("port-not-allowed");
  if (!isTargetAllowed(targets, host, port)) {
    return deny(hasHostEntry(targets, host) ? "port-not-allowed" : "host-not-allowed");
  }
  if (resolvedAddresses.length === 0) return deny("addresses-missing");
  for (const address of resolvedAddresses) {
    const kind = classifyAddress(address);
    if (kind === "denied") return deny("address-denied");
    if (kind === "unknown") return deny("address-unresolvable");
  }
  return { allowed: true, host, port, addresses: Object.freeze([...resolvedAddresses]) };
}

function deny(reason: TargetDenialReason): TargetCheck {
  return { allowed: false, reason };
}

function isValidEntry(entry: string): boolean {
  const separator = entry.lastIndexOf(":");
  if (separator <= 0) return false;
  const host = entry.slice(0, separator);
  const port = entry.slice(separator + 1);
  if (!HOST_PATTERN.test(host) || !PORT_PATTERN.test(port)) return false;
  return Number(port) <= 65535;
}

function hasHostEntry(targets: AllowedTargets, host: string): boolean {
  for (const entry of targets.entries) {
    if (entry.startsWith(`${host}:`)) return true;
  }
  return false;
}

/**
 * denied  — never reachable, even for a listed host (loopback, link-local,
 *           metadata, multicast, unspecified, broadcast).
 * private — reachable only because the host is explicitly listed.
 */
function classifyAddress(address: string): "denied" | "private" | "public" | "unknown" {
  const value = address.trim().toLowerCase();
  // A zone id (`fe80::1%eth0`) is not a routable target here.
  if (!value || value.includes("%")) return "unknown";
  if (value.startsWith("::ffff:")) {
    const embedded = value.slice("::ffff:".length);
    // The dotted form is classified as IPv4; any other spelling fails closed.
    return IPV4_PATTERN.test(embedded) ? classifyIPv4(embedded) : "denied";
  }
  if (IPV4_PATTERN.test(value)) return classifyIPv4(value);
  if (isIP(value) === 6) return classifyIPv6(value);
  return "unknown";
}

function classifyIPv4(value: string): "denied" | "private" | "public" | "unknown" {
  const octets = value.split(".").map(part => Number(part));
  if (octets.length !== 4 || octets.some(o => !Number.isInteger(o) || o < 0 || o > 255)) return "unknown";
  const [first, second] = octets;
  if (first === 0 || first === 127) return "denied";
  if (first === 169 && second === 254) return "denied";
  if (first === 255 && octets.every(o => o === 255)) return "denied";
  if (first === 10) return "private";
  if (first === 172 && second >= 16 && second <= 31) return "private";
  if (first === 192 && second === 168) return "private";
  if (first === 100 && second >= 64 && second <= 127) return "private";
  return "public";
}

function classifyIPv6(value: string): "denied" | "private" | "public" | "unknown" {
  if (value === "::" || value === "::1") return "denied";
  if (/^fe[89ab]/.test(value)) return "denied";
  if (value.startsWith("ff")) return "denied";
  if (value.startsWith("fd00:ec2::")) return "denied";
  if (value.startsWith("fc") || value.startsWith("fd")) return "private";
  return "public";
}
