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
/**
 * denied  — never reachable, even for a listed host (loopback, link-local,
 *           metadata, multicast, unspecified, broadcast).
 * private — reachable only because the host is explicitly listed.
 */
function classifyAddress(address: string): "denied" | "private" | "public" | "unknown" {
  const value = address.trim().toLowerCase();
  // A zone id (`fe80::1%eth0`) is not a routable target here.
  if (!value || value.includes("%")) return "unknown";
  if (IPV4_PATTERN.test(value)) return classifyIPv4(value);
  // Any other address is trusted only as a well-formed IPv6 literal, and its
  // groups are then classified numerically: the spelling of a mapped address
  // (::ffff:a.b.c.d, ::ffff:aabb:ccdd, 0:0:0:0:0:ffff:...) cannot change the verdict.
  if (isIP(value) !== 6) return "unknown";
  const groups = parseIPv6Groups(value);
  return groups ? classifyIPv6Groups(groups) : "unknown";
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

/** Expands an IPv6 literal to its eight 16-bit groups, or null when malformed. */
function parseIPv6Groups(value: string): number[] | null {
  let head = value;
  let embedded: number[] = [];
  const lastColon = value.lastIndexOf(":");
  const tail = lastColon >= 0 ? value.slice(lastColon + 1) : "";
  if (tail.includes(".")) {
    const octets = tail.split(".").map(part => Number(part));
    if (!IPV4_PATTERN.test(tail) || octets.some(octet => octet > 255)) return null;
    head = value.slice(0, lastColon + 1);
    embedded = [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    const texts = part ? part.split(":").filter(Boolean) : [];
    if (texts.some(text => !/^[0-9a-f]{1,4}$/.test(text))) return null;
    return texts.map(text => parseInt(text, 16));
  };
  const left = toGroups(halves[0]);
  const right = halves.length === 2 ? toGroups(halves[1]) : [];
  if (!left || !right) return null;
  const filled = left.length + right.length + embedded.length;
  if (halves.length === 1) return filled === 8 ? [...left, ...right, ...embedded] : null;
  const zeros = 8 - filled;
  if (zeros < 1) return null;
  return [...left, ...new Array<number>(zeros).fill(0), ...right, ...embedded];
}

function classifyIPv6Groups(groups: readonly number[]): "denied" | "private" | "public" | "unknown" {
  if (groups.length !== 8) return "unknown";
  const [first, second, third] = groups;
  if (groups.every(group => group === 0)) return "denied";
  const leading = groups.slice(0, 5);
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) forms keep
  // their embedded IPv4 verdict. Groups 0..4 are zero and group 5 is 0 or ffff.
  if (leading.every(group => group === 0) && (groups[5] === 0 || groups[5] === 0xffff)) {
    if (groups[6] === 0 && groups[7] <= 1) return "denied";
    return classifyIPv4(
      `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`,
    );
  }
  if (first >> 8 === 0xff) return "denied";
  if ((first & 0xffc0) === 0xfe80) return "denied";
  if (first === 0xfd00 && second === 0x0ec2 && third === 0) return "denied";
  if ((first & 0xfe00) === 0xfc00) return "private";
  return "public";
}
