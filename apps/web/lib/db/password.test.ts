import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password";

const VALID = "correct horse battery staple";
const FORMAT = /^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/;

describe("password helpers (K6F4-01b)", () => {
  it("round-trips: hash then verify returns true", () => {
    expect(verifyPassword(VALID, hashPassword(VALID))).toBe(true);
  });

  it("rejects a wrong password", () => {
    const stored = hashPassword(VALID);
    expect(verifyPassword("wrong password entirely", stored)).toBe(false);
  });

  it("stored format matches scrypt$16384$8$1$<hex>$<hex>", () => {
    expect(hashPassword(VALID)).toMatch(FORMAT);
  });

  it("two hashes of the same password differ (random per-user salt)", () => {
    expect(hashPassword(VALID)).not.toBe(hashPassword(VALID));
  });

  it("rejects a tampered stored hash", () => {
    const stored = hashPassword(VALID);
    const parts = stored.split("$");
    // Flip the last hex character of the derived hash.
    const last = parts[5];
    const flipped = last.slice(0, -1) + (last.endsWith("0") ? "1" : "0");
    parts[5] = flipped;
    expect(verifyPassword(VALID, parts.join("$"))).toBe(false);
  });

  it("malformed or missing-salt stored strings return false without throwing", () => {
    const good = hashPassword(VALID).split("$");
    const cases = [
      "",
      "garbage",
      "scrypt",
      "scrypt$16384$8$1$deadbeef",
      "scrypt$x$8$1$" + good[4] + "$" + good[5],
      "scrypt$16384$8$1$$" + good[5], // missing salt
      "scrypt$16384$8$1$zz$" + good[5], // non-hex salt
      "scrypt$16384$8$1$" + good[4].slice(0, 16) + "$" + good[5], // short salt
      "bcrypt$16384$8$1$" + good[4] + "$" + good[5], // wrong prefix
      "scrypt$16384$8$1$" + good[4] + "$" + good[5].slice(0, 64), // short hash
      "scrypt$999999999$8$1$" + good[4] + "$" + good[5], // DoS-bounded params
    ];
    for (const stored of cases) {
      expect(verifyPassword(VALID, stored)).toBe(false);
    }
  });

  it("hashPassword(\"\") throws a clear error (never hashes blank passwords)", () => {
    expect(() => hashPassword("")).toThrow(/non-blank/i);
    expect(() => hashPassword("   ")).toThrow(/non-blank/i);
  });

  it("verifyPassword with blank plain returns false", () => {
    const stored = hashPassword(VALID);
    expect(verifyPassword("", stored)).toBe(false);
    expect(verifyPassword("   ", stored)).toBe(false);
  });
});
