import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// K6F4-01b: scrypt password helpers via node:crypto — no hashing dependency.
// Params are fixed at N=16384, r=8, p=1, keylen=64; per-user 16-byte random
// salt; stored format `scrypt$N$r$p$<salt-hex>$<hash-hex>`.
//
// Sync form (scryptSync) is a deliberate choice: the contract signatures are
// synchronous, and at N=16384/r=8/p=1 a derivation costs ~50-100 ms —
// acceptable for the seed CLI and for login-frequency web handlers (K6F4-02),
// which can simply `await` nothing. If concurrent-login profiling later shows
// event-loop pressure, an async twin can be added without changing the stored
// format.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;
const PREFIX = "scrypt";

function isBlank(plain: unknown): boolean {
  return typeof plain !== "string" || plain.trim().length === 0;
}

export function hashPassword(plain: string): string {
  if (isBlank(plain)) {
    throw new Error("hashPassword: password must be a non-blank string");
  }
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(plain, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `${PREFIX}$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  if (isBlank(plain)) return false;
  if (typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== PREFIX) return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) return false;
  // Bound the embedded params so a tampered stored string cannot DoS or crash
  // verification (memory ≈ 128·N·r bytes; keep it under scrypt's 32 MiB default).
  if (n < 1024 || n > 65536 || (n & (n - 1)) !== 0) return false;
  if (r < 1 || r > 32 || p < 1 || p > 16 || n * r > 262144) return false;
  if (!/^[0-9a-f]+$/i.test(parts[4]) || parts[4].length !== SALT_BYTES * 2) return false;
  if (!/^[0-9a-f]+$/i.test(parts[5]) || parts[5].length !== KEYLEN * 2) return false;
  try {
    const salt = Buffer.from(parts[4], "hex");
    const expected = Buffer.from(parts[5], "hex");
    const actual = scryptSync(plain, salt, KEYLEN, { N: n, r, p });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    // Malformed/tampered material must never throw out of verification.
    return false;
  }
}
