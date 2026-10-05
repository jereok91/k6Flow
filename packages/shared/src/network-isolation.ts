/**
 * Network isolation - block private ranges and metadata endpoints
 * Protects against SSRF attacks
 */

// Private IPv4 ranges (RFC 1918)
const PRIVATE_IPV4_RANGES = [
  { start: [10, 0, 0, 0], end: [10, 255, 255, 255] },         // 10.0.0.0/8
  { start: [172, 16, 0, 0], end: [172, 31, 255, 255] },       // 172.16.0.0/12
  { start: [192, 168, 0, 0], end: [192, 168, 255, 255] },     // 192.168.0.0/16
  { start: [127, 0, 0, 0], end: [127, 255, 255, 255] },       // 127.0.0.0/8 (localhost)
  { start: [169, 254, 0, 0], end: [169, 254, 255, 255] },     // 169.254.0.0/16 (link-local)
  { start: [0, 0, 0, 0], end: [0, 255, 255, 255] },           // 0.0.0.0/8 (this network)
];

// Cloud metadata endpoints
const METADATA_HOSTS = new Set([
  "169.254.169.254",       // AWS, GCP, Azure
  "metadata.google.internal",
  "metadata.gke.internal",
  "100.100.100.200",       // Alibaba Cloud
  "fd00:ec2::254",         // AWS IPv6
]);

// Blocked hostnames
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "kubernetes.default.svc",
  "kubernetes.default",
]);

/**
 * Parse IPv4 address to array of octets
 */
function parseIPv4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  
  const octets = parts.map((p) => parseInt(p, 10));
  if (octets.some((o) => isNaN(o) || o < 0 || o > 255)) return null;
  
  return octets;
}

/**
 * Check if IP is in a private range
 */
function isInRange(ip: number[], range: { start: number[]; end: number[] }): boolean {
  for (let i = 0; i < 4; i++) {
    if (ip[i] < range.start[i] || ip[i] > range.end[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Check if a hostname is a private/blocked address
 */
function isPrivateHost(hostname: string): boolean {
  // Check blocked hostnames
  const lowerHost = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(lowerHost)) {
    return true;
  }

  // Check metadata endpoints
  if (METADATA_HOSTS.has(lowerHost)) {
    return true;
  }

  // Check if it's an IPv4 address
  const ip = parseIPv4(hostname);
  if (ip) {
    for (const range of PRIVATE_IPV4_RANGES) {
      if (isInRange(ip, range)) {
        return true;
      }
    }
  }

  // Check IPv6 localhost
  if (hostname === "::1" || hostname === "[::1]") {
    return true;
  }

  // Check for numeric localhost variants
  if (/^0x7f/i.test(hostname) || hostname.startsWith("2130706")) {
    return true;
  }

  return false;
}

export interface NetworkIsolationResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Check if a URL is safe to access (not private/internal)
 */
export function validateUrl(url: string): NetworkIsolationResult {
  try {
    const parsed = new URL(url);

    // Only allow http/https
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return { allowed: false, reason: `Protocol not allowed: ${parsed.protocol}` };
    }

    // Check hostname
    if (isPrivateHost(parsed.hostname)) {
      return { allowed: false, reason: "Private/internal network access blocked" };
    }

    // Block file:// and other dangerous protocols that might be embedded
    if (url.toLowerCase().includes("file:")) {
      return { allowed: false, reason: "File protocol not allowed" };
    }

    return { allowed: true };
  } catch {
    return { allowed: false, reason: "Invalid URL" };
  }
}

/**
 * List of safe domains for recording (can be extended)
 */
export function isAllowedDomain(hostname: string, allowedDomains?: string[]): boolean {
  if (!allowedDomains || allowedDomains.length === 0) {
    // No restrictions if no domains specified
    return !isPrivateHost(hostname);
  }

  const lowerHost = hostname.toLowerCase();
  return allowedDomains.some((domain) => {
    const lowerDomain = domain.toLowerCase();
    return lowerHost === lowerDomain || lowerHost.endsWith("." + lowerDomain);
  });
}

export interface NetworkIsolationConfig {
  /** Block all private ranges (default: true) */
  blockPrivateRanges?: boolean;
  /** Block cloud metadata endpoints (default: true) */
  blockMetadata?: boolean;
  /** Allowed domains (if set, only these are allowed) */
  allowedDomains?: string[];
}

/**
 * Create a URL validator with custom config
 */
export function createUrlValidator(config: NetworkIsolationConfig = {}): (url: string) => NetworkIsolationResult {
  const { blockPrivateRanges = true, blockMetadata = true, allowedDomains } = config;

  return (url: string): NetworkIsolationResult => {
    try {
      const parsed = new URL(url);

      // Protocol check
      if (!["http:", "https:"].includes(parsed.protocol)) {
        return { allowed: false, reason: `Protocol not allowed: ${parsed.protocol}` };
      }

      // Private range check
      if (blockPrivateRanges && isPrivateHost(parsed.hostname)) {
        return { allowed: false, reason: "Private network access blocked" };
      }

      // Metadata check
      if (blockMetadata && METADATA_HOSTS.has(parsed.hostname.toLowerCase())) {
        return { allowed: false, reason: "Cloud metadata access blocked" };
      }

      // Allowed domains check
      if (allowedDomains && !isAllowedDomain(parsed.hostname, allowedDomains)) {
        return { allowed: false, reason: "Domain not in allowlist" };
      }

      return { allowed: true };
    } catch {
      return { allowed: false, reason: "Invalid URL" };
    }
  };
}
