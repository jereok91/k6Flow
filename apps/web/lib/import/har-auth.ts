/**
 * Auth injection for the HAR import screen: HAR exports frequently travel
 * without credentials, so the user declares one scheme here and the import
 * stamps the resulting header onto the requests that go to the server.
 *
 * Pure on purpose: no `Buffer`, no `btoa`, no DOM, so the same code runs in the
 * browser and in the node test runner. `har-preview.ts` keeps the pruning; this
 * module only decides which header to write and where.
 */

import type { Har, HarEntry } from "@k6flow/shared";
import { pruneHar } from "./har-preview";

/** Authentication schemes the panel offers. */
export type HarAuthKind = "none" | "bearer" | "basic" | "api-key" | "cookie" | "custom-header";

/** Which rows of the selection receive the header. */
export type HarAuthScope = "all" | "some";

/**
 * The chosen scheme. One flat object: only the fields the kind needs are read,
 * so switching scheme never loses what the user already typed in the others.
 */
export interface HarAuthConfig {
  kind: HarAuthKind;
  /** Bearer/JWT token (`bearer`). */
  token?: string;
  /** Basic credentials (`basic`); the password may be empty. */
  username?: string;
  password?: string;
  /** Header name for `api-key` (defaults to `x-api-key`) and `custom-header`. */
  headerName?: string;
  /** Header value for `api-key` and `custom-header`. */
  headerValue?: string;
  /** Literal cookie pair list sent in `Cookie` (`cookie`). */
  cookie?: string;
  /** Rows the header goes to: every selected row or only the picked ones. */
  scope?: HarAuthScope;
}

/** Nothing configured: no header, every selected row in scope. */
export const EMPTY_AUTH_CONFIG: HarAuthConfig = { kind: "none", scope: "all" };

/** Default API-key header, as most APIs expect it. */
const API_KEY_HEADER = "x-api-key";

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Trimmed text of an optional field, so blanks mean "not filled in". */
function text(value: string | undefined): string {
  return (value ?? "").trim();
}

/** UTF-8 bytes of `text`; `TextEncoder` is not always around, so this is plain JS. */
function utf8Bytes(value: string): number[] {
  const bytes: number[] = [];
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return bytes;
}

/** Standard, padded base64 of the UTF-8 bytes of `value`. */
export function base64Encode(value: string): string {
  const bytes = utf8Bytes(value);
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    encoded += BASE64_ALPHABET[first >> 2];
    encoded += BASE64_ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >> 4)];
    encoded += second === undefined ? "=" : BASE64_ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >> 6)];
    encoded += third === undefined ? "=" : BASE64_ALPHABET[third & 0x3f];
  }
  return encoded;
}

/**
 * Header the scheme produces, or `null` when the scheme is `none` or the config
 * is incomplete (empty token, empty header name or value, ...).
 */
export function authHeaderFor(config: HarAuthConfig): { name: string; value: string } | null {
  switch (config.kind) {
    case "bearer": {
      const token = text(config.token);
      return token.length === 0 ? null : { name: "Authorization", value: `Bearer ${token}` };
    }
    case "basic": {
      // The password is joined verbatim: its spaces are part of the credential.
      const username = config.username ?? "";
      if (username.trim().length === 0) return null;
      return {
        name: "Authorization",
        value: `Basic ${base64Encode(`${username}:${config.password ?? ""}`)}`,
      };
    }
    case "api-key": {
      const value = text(config.headerValue);
      if (value.length === 0) return null;
      return { name: text(config.headerName) || API_KEY_HEADER, value };
    }
    case "cookie": {
      const cookie = text(config.cookie);
      return cookie.length === 0 ? null : { name: "Cookie", value: cookie };
    }
    case "custom-header": {
      const name = text(config.headerName);
      const value = text(config.headerValue);
      return name.length === 0 || value.length === 0 ? null : { name, value };
    }
    case "none":
      return null;
  }
}

/** One entry with `header` written in, replacing any header of the same name. */
function withHeader(entry: HarEntry, header: { name: string; value: string }): HarEntry {
  const headers = entry.request?.headers ?? [];
  const isSameName = (current: { name: string }): boolean =>
    current.name.toLowerCase() === header.name.toLowerCase();
  const firstMatch = headers.findIndex(isSameName);
  // Duplicated headers of the same name collapse into the one written here.
  const kept = firstMatch === -1
    ? headers
    : headers.filter((current, index) => !isSameName(current) || index === firstMatch);
  const nextHeaders = firstMatch === -1
    ? [...kept, header]
    : kept.map((current, index) => (index === firstMatch ? header : current));

  return { ...entry, request: { ...entry.request, headers: nextHeaders } };
}

/**
 * Returns a NEW HAR with the scheme's header added to the entries whose original
 * index is in `keepIndexes`, in the order those appear. Every other entry, log
 * field and top-level key is copied unchanged and the input is never mutated.
 * When the config produces no header the entries come back untouched.
 */
export function applyAuthToHar(
  har: Har,
  config: HarAuthConfig,
  keepIndexes: ReadonlySet<number>,
): Har {
  const header = authHeaderFor(config);
  const entries = har.log?.entries ?? [];

  return {
    ...har,
    log: {
      ...har.log,
      entries: header === null
        ? [...entries]
        : entries.map((entry, index) => (keepIndexes.has(index) ? withHeader(entry, header) : entry)),
    },
  };
}

/** Every entry index of `har`, so an already pruned HAR can be pruned again as-is. */
export function entryIndexes(har: Har): ReadonlySet<number> {
  return new Set((har.log?.entries ?? []).map((_entry, index) => index));
}

/**
 * HAR to upload: pruned to the checked rows and then stamped with the auth
 * header on the rows the panel scoped in. Pruning first means the mapping from
 * original indexes to uploaded positions lives here instead of in the page.
 *
 * `picked` is the subset chosen in "solo algunas"; `null` means every selected
 * row.
 */
export function buildUploadHar(
  har: Har,
  config: HarAuthConfig,
  keepIndexes: ReadonlySet<number>,
  picked: ReadonlySet<number> | null = null,
): Har {
  const pruned = pruneHar(har, keepIndexes);
  if (authHeaderFor(config) === null) return pruned;

  const scoped = config.scope === "some" && picked !== null ? picked : keepIndexes;
  // `pruneHar` keeps the entries in file order, so the n-th kept index is the
  // n-th uploaded position.
  const positions = new Set<number>();
  [...keepIndexes]
    .sort((left, right) => left - right)
    .forEach((originalIndex, position) => {
      if (scoped.has(originalIndex)) positions.add(position);
    });

  return applyAuthToHar(pruned, config, positions);
}
