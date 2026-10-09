// Parse a "Copy as cURL" command (bash or Windows cmd) into HTTP request parts.
// Uses a shell-like tokenizer instead of regexes over the whole string so that
// quoted values containing quotes, ANSI-C strings and continuations survive.

export type CurlBodyKind = "json" | "form" | "text" | "xml";

export interface CurlHeader {
  name: string;
  value: string;
}

export type CurlParseResult =
  | {
      ok: true;
      method: string;
      url: string;
      headers: CurlHeader[];
      body?: { kind: CurlBodyKind; value: string };
      warnings: string[];
    }
  | { ok: false; error: string };

class TokenizeError extends Error {}

// -----------------------------------------------------------------------------
// Normalization & tokenizing
// -----------------------------------------------------------------------------

function looksLikeCmd(input: string): boolean {
  return input.includes('^"') || /\^[ \t]*\r?\n/.test(input) || /\^[ \t]*$/.test(input);
}

function normalizeCmd(input: string): string {
  return input
    .replace(/\^[ \t]*\r?\n/g, " ") // ^ line continuations
    .replace(/\^[ \t]*$/, "")
    .replace(/\^([\s\S])/g, "$1"); // ^X escapes -> X
}

function readAnsiC(input: string, start: number): { value: string; end: number } {
  // start points just after the opening `$'`
  let out = "";
  let i = start;
  while (i < input.length) {
    const ch = input[i];
    if (ch === "'") return { value: out, end: i + 1 };
    if (ch !== "\\") {
      out += ch;
      i++;
      continue;
    }
    const next = input[i + 1];
    if (next === undefined) break;
    i += 2;
    switch (next) {
      case "n": out += "\n"; break;
      case "t": out += "\t"; break;
      case "r": out += "\r"; break;
      case "a": out += "\x07"; break;
      case "b": out += "\b"; break;
      case "e":
      case "E": out += "\x1b"; break;
      case "f": out += "\f"; break;
      case "v": out += "\v"; break;
      case "'": out += "'"; break;
      case '"': out += '"'; break;
      case "\\": out += "\\"; break;
      case "?": out += "?"; break;
      case "x": {
        const m = /^[0-9a-fA-F]{1,2}/.exec(input.slice(i));
        if (m) {
          out += String.fromCharCode(parseInt(m[0], 16));
          i += m[0].length;
        } else out += "\\x";
        break;
      }
      case "u":
      case "U": {
        const max = next === "u" ? 4 : 8;
        const m = new RegExp(`^[0-9a-fA-F]{1,${max}}`).exec(input.slice(i));
        if (m) {
          out += String.fromCodePoint(parseInt(m[0], 16));
          i += m[0].length;
        } else out += "\\" + next;
        break;
      }
      default: {
        if (next >= "0" && next <= "7") {
          const m = /^[0-7]{1,3}/.exec(input.slice(i - 1));
          out += String.fromCharCode(parseInt(m![0], 8));
          i += m![0].length - 1;
        } else {
          out += "\\" + next;
        }
      }
    }
  }
  throw new TokenizeError("Unterminated $'...' string");
}

export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inToken = false;
  let i = 0;

  const push = () => {
    if (inToken) tokens.push(current);
    current = "";
    inToken = false;
  };

  while (i < input.length) {
    const ch = input[i];

    if (ch === "\\") {
      const next = input[i + 1];
      if (next === "\n") {
        i += 2;
        continue;
      }
      if (next === "\r" && input[i + 2] === "\n") {
        i += 3;
        continue;
      }
      if (next === undefined) {
        i++;
        continue;
      }
      current += next;
      inToken = true;
      i += 2;
      continue;
    }

    if (/\s/.test(ch)) {
      push();
      i++;
      continue;
    }

    if (ch === "$" && input[i + 1] === "'") {
      const { value, end } = readAnsiC(input, i + 2);
      current += value;
      inToken = true;
      i = end;
      continue;
    }

    if (ch === "'") {
      const end = input.indexOf("'", i + 1);
      if (end === -1) throw new TokenizeError("Unterminated single-quoted string");
      current += input.slice(i + 1, end);
      inToken = true;
      i = end + 1;
      continue;
    }

    if (ch === '"') {
      i++;
      inToken = true;
      let closed = false;
      while (i < input.length) {
        const c = input[i];
        if (c === '"') {
          closed = true;
          i++;
          break;
        }
        if (c === "\\") {
          const n = input[i + 1];
          if (n === "\n") {
            i += 2;
            continue;
          }
          if (n === "\r" && input[i + 2] === "\n") {
            i += 3;
            continue;
          }
          if (n === '"' || n === "\\" || n === "$" || n === "`") {
            current += n;
            i += 2;
            continue;
          }
        }
        current += c;
        i++;
      }
      if (!closed) throw new TokenizeError("Unterminated double-quoted string");
      continue;
    }

    current += ch;
    inToken = true;
    i++;
  }
  push();
  return tokens;
}

// -----------------------------------------------------------------------------
// Flag tables
// -----------------------------------------------------------------------------

type ValueFlag =
  | "method"
  | "header"
  | "cookie"
  | "user-agent"
  | "referer"
  | "user"
  | "data"
  | "data-raw"
  | "data-urlencode"
  | "json"
  | "url"
  | "form"
  | "ignore";

const LONG_VALUE_FLAGS: Record<string, ValueFlag> = {
  "--request": "method",
  "--header": "header",
  "--cookie": "cookie",
  "--user-agent": "user-agent",
  "--referer": "referer",
  "--user": "user",
  "--data": "data",
  "--data-ascii": "data",
  "--data-binary": "data",
  "--data-raw": "data-raw",
  "--data-urlencode": "data-urlencode",
  "--json": "json",
  "--url": "url",
  "--form": "form",
  "--form-string": "form",
  "--output": "ignore",
  "--max-time": "ignore",
  "--connect-timeout": "ignore",
  "--write-out": "ignore",
  "--proxy": "ignore",
  "--proxy-user": "ignore",
  "--cacert": "ignore",
  "--capath": "ignore",
  "--cert": "ignore",
  "--cert-type": "ignore",
  "--key": "ignore",
  "--key-type": "ignore",
  "--cookie-jar": "ignore",
  "--retry": "ignore",
  "--retry-delay": "ignore",
  "--retry-max-time": "ignore",
  "--resolve": "ignore",
  "--connect-to": "ignore",
  "--interface": "ignore",
  "--limit-rate": "ignore",
  "--max-redirs": "ignore",
  "--range": "ignore",
  "--upload-file": "ignore",
  "--dump-header": "ignore",
  "--config": "ignore",
  "--trace": "ignore",
  "--trace-ascii": "ignore",
  "--stderr": "ignore",
};

const SHORT_VALUE_FLAGS: Record<string, ValueFlag> = {
  X: "method",
  H: "header",
  b: "cookie",
  A: "user-agent",
  e: "referer",
  u: "user",
  d: "data",
  F: "form",
  o: "ignore",
  m: "ignore",
  w: "ignore",
  x: "ignore",
  U: "ignore",
  E: "ignore",
  c: "ignore",
  r: "ignore",
  T: "ignore",
  D: "ignore",
  K: "ignore",
  C: "ignore",
  Y: "ignore",
  y: "ignore",
  z: "ignore",
};

// Value-less short flags we accept silently (G and I are handled explicitly).
const SHORT_BOOL_FLAGS = new Set(["k", "L", "s", "S", "v", "i", "f", "N", "g", "#", "0", "1", "2", "3", "4", "6", "j", "l", "n", "O", "p", "q", "R", "Z", "G", "I"]);

const LONG_BOOL_FLAGS = new Set([
  "--compressed",
  "--insecure",
  "--location",
  "--location-trusted",
  "--silent",
  "--show-error",
  "--verbose",
  "--include",
  "--fail",
  "--fail-with-body",
  "--no-buffer",
  "--globoff",
  "--progress-bar",
  "--http1.0",
  "--http1.1",
  "--http2",
  "--http2-prior-knowledge",
  "--http3",
  "--tlsv1",
  "--tlsv1.0",
  "--tlsv1.1",
  "--tlsv1.2",
  "--tlsv1.3",
  "--ipv4",
  "--ipv6",
  "--no-keepalive",
  "--tcp-nodelay",
  "--path-as-is",
  "--remote-name",
  "--remote-name-all",
  "--create-dirs",
  "--raw",
  "--tr-encoding",
  "--no-progress-meter",
  "--digest",
  "--basic",
  "--ntlm",
  "--negotiate",
  "--anyauth",
]);

const DROPPED_HEADERS = new Set(["content-type", "content-length", "host", "connection", "accept-encoding"]);

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function urlencodeData(value: string): string {
  // curl --data-urlencode semantics: "name=content", "=content" or "content".
  const eq = value.indexOf("=");
  if (eq === -1) return encodeURIComponent(value);
  const name = value.slice(0, eq);
  const content = encodeURIComponent(value.slice(eq + 1));
  return name ? `${name}=${content}` : content;
}

function looksLikeForm(body: string): boolean {
  return /^[^=&\s]+=[^&\s]*(&[^=&\s]+=[^&\s]*)*$/.test(body);
}

function inferBodyKind(body: string, contentType: string | undefined): CurlBodyKind {
  if (contentType !== undefined) {
    const ct = contentType.toLowerCase();
    if (ct.includes("application/json") || /\+json\b/.test(ct)) return "json";
    if (ct.includes("x-www-form-urlencoded")) return "form";
    if (ct.includes("xml")) return "xml";
    return "text";
  }
  try {
    JSON.parse(body);
    return "json";
  } catch {
    // not JSON
  }
  return looksLikeForm(body) ? "form" : "text";
}

// -----------------------------------------------------------------------------
// Parser
// -----------------------------------------------------------------------------

export function parseCurl(input: string): CurlParseResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: "Paste a cURL command to import." };

  let tokens: string[];
  try {
    const source = looksLikeCmd(trimmed) ? normalizeCmd(trimmed) : trimmed;
    tokens = tokenize(source);
  } catch (e) {
    return { ok: false, error: `Could not parse cURL command: ${(e as Error).message}.` };
  }

  const first = tokens[0]?.toLowerCase();
  if (first !== "curl" && first !== "curl.exe") {
    return { ok: false, error: "Command must start with 'curl'." };
  }

  let explicitMethod: string | undefined;
  let forceGet = false;
  let head = false;
  let url: string | undefined;
  let jsonFlag = false;
  const headers: CurlHeader[] = [];
  const dataParts: string[] = [];
  const warnings: string[] = [];

  const addHeader = (raw: string) => {
    const colon = raw.indexOf(":");
    if (colon === -1) return;
    const name = raw.slice(0, colon).trim();
    if (!name) return;
    headers.push({ name, value: raw.slice(colon + 1).trim() });
  };

  const apply = (flag: ValueFlag, value: string, display: string) => {
    switch (flag) {
      case "method":
        explicitMethod = value.toUpperCase();
        break;
      case "header":
        addHeader(value);
        break;
      case "cookie":
        if (value.includes("=")) headers.push({ name: "Cookie", value });
        else warnings.push(`Ignored cookie file "${value}" (${display}).`);
        break;
      case "user-agent":
        headers.push({ name: "User-Agent", value });
        break;
      case "referer":
        headers.push({ name: "Referer", value: value.replace(/;auto$/, "") });
        break;
      case "user":
        headers.push({ name: "Authorization", value: `Basic ${base64(value)}` });
        break;
      case "data":
        if (value.startsWith("@")) warnings.push(`File data "${value}" is not supported; it was imported literally.`);
        dataParts.push(value);
        break;
      case "data-raw":
        dataParts.push(value);
        break;
      case "data-urlencode":
        dataParts.push(urlencodeData(value));
        break;
      case "json":
        jsonFlag = true;
        dataParts.push(value);
        break;
      case "url":
        url ??= value;
        break;
      case "form":
        warnings.push(`Multipart form data (${display} ${value}) is not supported and was skipped.`);
        break;
      case "ignore":
        break;
    }
  };

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];

    if (token.startsWith("--") && token.length > 2) {
      const eq = token.indexOf("=");
      const name = eq === -1 ? token : token.slice(0, eq);
      if (name === "--get") {
        forceGet = true;
        continue;
      }
      if (name === "--head") {
        head = true;
        continue;
      }
      const flag = LONG_VALUE_FLAGS[name];
      if (flag) {
        let value: string | undefined;
        if (eq !== -1) value = token.slice(eq + 1);
        else value = tokens[++i];
        if (value === undefined) {
          warnings.push(`Option ${name} is missing a value.`);
          continue;
        }
        apply(flag, value, name);
        continue;
      }
      if (!LONG_BOOL_FLAGS.has(name)) warnings.push(`Ignored unsupported option ${name}.`);
      continue;
    }

    if (token.startsWith("-") && token.length > 1) {
      const letter = token[1];
      const flag = SHORT_VALUE_FLAGS[letter];
      if (flag) {
        const value: string | undefined = token.length > 2 ? token.slice(2) : tokens[++i];
        if (value === undefined) {
          warnings.push(`Option -${letter} is missing a value.`);
          continue;
        }
        apply(flag, value, `-${letter}`);
        continue;
      }
      // Combined value-less flags, e.g. -sSL or -kG
      const letters = token.slice(1).split("");
      for (let j = 0; j < letters.length; j++) {
        const l = letters[j];
        if (l === "G") forceGet = true;
        else if (l === "I") head = true;
        else if (SHORT_VALUE_FLAGS[l]) {
          // value-taking flag at the end of a group, e.g. -sX POST
          const rest = token.slice(j + 2);
          const value = rest || tokens[++i];
          if (value !== undefined) apply(SHORT_VALUE_FLAGS[l], value, `-${l}`);
          break;
        } else if (!SHORT_BOOL_FLAGS.has(l)) {
          warnings.push(`Ignored unsupported option -${l}.`);
        }
      }
      continue;
    }

    // Positional: first one is the URL
    if (url === undefined) url = token;
    else warnings.push(`Ignored extra argument "${token}".`);
  }

  if (!url) return { ok: false, error: "No URL found in the cURL command." };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`;

  const contentType = [...headers].reverse().find((h) => h.name.toLowerCase() === "content-type")?.value;
  const filteredHeaders = headers.filter((h) => {
    const lower = h.name.toLowerCase();
    return !lower.startsWith(":") && !DROPPED_HEADERS.has(lower);
  });

  let body: { kind: CurlBodyKind; value: string } | undefined;
  let method: string;

  if (forceGet) {
    method = explicitMethod ?? (head ? "HEAD" : "GET");
    if (dataParts.length > 0) {
      const query = dataParts.join("&");
      url += (url.includes("?") ? (url.endsWith("?") || url.endsWith("&") ? "" : "&") : "?") + query;
    }
  } else {
    if (dataParts.length > 0) {
      const value = jsonFlag ? dataParts.join("") : dataParts.join("&");
      const kind = jsonFlag && contentType === undefined ? "json" : inferBodyKind(value, contentType);
      body = { kind, value };
    }
    method = explicitMethod ?? (head ? "HEAD" : body ? "POST" : "GET");
  }

  return {
    ok: true,
    method,
    url,
    headers: filteredHeaders,
    ...(body ? { body } : {}),
    warnings,
  };
}
