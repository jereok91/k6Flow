import { describe, expect, it } from "vitest";
import { parseCurl } from "./curl-import";

function ok(input: string) {
  const result = parseCurl(input);
  if (!result.ok) throw new Error(`expected ok, got error: ${result.error}`);
  return result;
}

function header(result: ReturnType<typeof ok>, name: string): string | undefined {
  return result.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

describe("parseCurl", () => {
  it("parses a Chrome 'Copy as cURL (bash)' command", () => {
    const input = [
      "curl 'http://localhost:3031/auth/login' \\",
      "  -H 'Accept: application/json, text/plain, */*' \\",
      "  -H 'Accept-Language: en-US,en;q=0.9' \\",
      "  -H 'Connection: keep-alive' \\",
      "  -H 'Content-Type: application/json' \\",
      "  -b 'session=abc123; theme=dark' \\",
      "  -H 'Origin: http://localhost:3000' \\",
      "  -H 'sec-ch-ua: \"Chromium\";v=\"154\", \"Not-A.Brand\";v=\"24\"' \\",
      "  --data-raw '{\"email\":\"a@b.c\",\"password\":\"x\"}' \\",
      "  --compressed",
    ].join("\n");

    const result = ok(input);
    expect(result.method).toBe("POST");
    expect(result.url).toBe("http://localhost:3031/auth/login");
    expect(result.body).toEqual({ kind: "json", value: '{"email":"a@b.c","password":"x"}' });
    expect(header(result, "sec-ch-ua")).toBe('"Chromium";v="154", "Not-A.Brand";v="24"');
    expect(header(result, "Cookie")).toBe("session=abc123; theme=dark");
    expect(header(result, "Accept")).toBe("application/json, text/plain, */*");
    expect(header(result, "Content-Type")).toBeUndefined();
    expect(header(result, "Connection")).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it("handles CRLF line continuations", () => {
    const result = ok("curl 'https://x.io/a' \\\r\n  -H 'X-A: 1'");
    expect(result.url).toBe("https://x.io/a");
    expect(header(result, "X-A")).toBe("1");
  });

  it("parses ANSI-C $'...' quoting", () => {
    const input = "curl 'https://api.test/x' -H 'Content-Type: text/plain' --data-raw $'line1\\nit\\'s \\\"q\\\" \\x41\\u00e9'";
    const result = ok(input);
    expect(result.method).toBe("POST");
    expect(result.body).toEqual({ kind: "text", value: "line1\nit's \"q\" A\u00e9" });
  });

  it("parses Windows cmd format with ^\" escapes and ^ continuations", () => {
    const input = [
      'curl ^"http://localhost:3031/auth/login^" ^',
      '  -H ^"Content-Type: application/json^" ^',
      '  -H ^"sec-ch-ua: ^\\^"Chromium^\\^";v=^\\^"154^\\^"^" ^',
      '  --data-raw ^"^{^\\^"email^\\^":^\\^"a@b.c^\\^"^}^"',
    ].join("\r\n");
    const result = ok(input);
    expect(result.method).toBe("POST");
    expect(result.url).toBe("http://localhost:3031/auth/login");
    expect(header(result, "sec-ch-ua")).toBe('"Chromium";v="154"');
    expect(result.body).toEqual({ kind: "json", value: '{"email":"a@b.c"}' });
  });

  it("accepts curl.exe and case-insensitive curl", () => {
    expect(ok("CURL https://a.b/").url).toBe("https://a.b/");
    expect(ok("curl.exe https://a.b/").url).toBe("https://a.b/");
  });

  it("converts -u user:pass to Basic auth", () => {
    const result = ok("curl -u user:pass https://a.b/");
    expect(header(result, "Authorization")).toBe(`Basic ${Buffer.from("user:pass").toString("base64")}`);
    expect(result.method).toBe("GET");
  });

  it("moves data into the query string with -G", () => {
    const result = ok("curl -G https://a.b/search -d q=hello -d page=2");
    expect(result.method).toBe("GET");
    expect(result.url).toBe("https://a.b/search?q=hello&page=2");
    expect(result.body).toBeUndefined();
  });

  it("appends -G data to an existing query string", () => {
    const result = ok("curl -G 'https://a.b/s?x=1' --data-urlencode y=2");
    expect(result.url).toBe("https://a.b/s?x=1&y=2");
  });

  it("supports attached method forms", () => {
    expect(ok("curl -XPUT https://a.b/").method).toBe("PUT");
    expect(ok("curl --request=PATCH https://a.b/").method).toBe("PATCH");
    expect(ok("curl -X delete https://a.b/").method).toBe("DELETE");
    expect(header(ok("curl --header=X-K:v https://a.b/"), "X-K")).toBe("v");
  });

  it("keeps an explicit method even with data", () => {
    const result = ok("curl -X PUT https://a.b/ -d 'a=1'");
    expect(result.method).toBe("PUT");
    expect(result.body).toEqual({ kind: "form", value: "a=1" });
  });

  it("supports --json", () => {
    const result = ok(`curl --json '{"a":1}' https://a.b/`);
    expect(result.method).toBe("POST");
    expect(result.body).toEqual({ kind: "json", value: '{"a":1}' });
  });

  it("supports --url, -A, -e and -I", () => {
    const result = ok("curl -I -A 'Agent/1' -e https://ref.io --url https://a.b/x");
    expect(result.url).toBe("https://a.b/x");
    expect(result.method).toBe("HEAD");
    expect(header(result, "User-Agent")).toBe("Agent/1");
    expect(header(result, "Referer")).toBe("https://ref.io");
  });

  it("prepends http:// to a URL without scheme", () => {
    expect(ok("curl example.com/path").url).toBe("http://example.com/path");
  });

  it("joins multiple data flags with &", () => {
    const result = ok("curl https://a.b/ -d a=1 --data-binary b=2");
    expect(result.body).toEqual({ kind: "form", value: "a=1&b=2" });
    expect(result.method).toBe("POST");
  });

  it("skips value-less and unmodelled value flags", () => {
    const result = ok("curl -k -L -s --compressed -o out.txt -m 10 --connect-timeout 5 -w '%{http_code}' --proxy http://p:1 https://a.b/");
    expect(result.url).toBe("https://a.b/");
    expect(result.headers).toEqual([]);
  });

  it("warns on multipart -F", () => {
    const result = ok("curl -F file=@a.txt https://a.b/upload");
    expect(result.url).toBe("https://a.b/upload");
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toMatch(/multipart|-F/i);
  });

  it("uses Content-Type to choose the body kind and drops the header", () => {
    const form = ok("curl https://a.b/ -H 'Content-Type: application/x-www-form-urlencoded' -d 'x'");
    expect(form.body?.kind).toBe("form");
    expect(header(form, "Content-Type")).toBeUndefined();

    const xml = ok("curl https://a.b/ -H 'content-type: application/xml' -d '<a/>'");
    expect(xml.body?.kind).toBe("xml");

    const vendorJson = ok("curl https://a.b/ -H 'Content-Type: application/vnd.api+json' -d 'not json'");
    expect(vendorJson.body?.kind).toBe("json");

    const text = ok(`curl https://a.b/ -H 'Content-Type: text/plain' -d '{"a":1}'`);
    expect(text.body?.kind).toBe("text");
    expect(text.headers).toEqual([]);
  });

  it("infers body kind without Content-Type", () => {
    expect(ok(`curl https://a.b/ -d '{"a":1}'`).body?.kind).toBe("json");
    expect(ok("curl https://a.b/ -d 'a=1&b=2'").body?.kind).toBe("form");
    expect(ok("curl https://a.b/ -d 'hello world'").body?.kind).toBe("text");
  });

  it("drops hop-by-hop, pseudo and empty-name headers", () => {
    const result = ok(
      "curl https://a.b/ -H 'Host: a.b' -H 'Content-Length: 3' -H 'Accept-Encoding: gzip' -H ':authority: a.b' -H ': x' -H 'X-Keep: 1'",
    );
    expect(result.headers).toEqual([{ name: "X-Keep", value: "1" }]);
  });

  it("handles double-quoted values with escapes", () => {
    const result = ok(`curl "https://a.b/" -H "X-Q: say \\"hi\\"" -d "{\\"a\\":\\"b\\"}"`);
    expect(header(result, "X-Q")).toBe('say "hi"');
    expect(result.body).toEqual({ kind: "json", value: '{"a":"b"}' });
  });

  it("returns an error for non-curl input", () => {
    const result = parseCurl("wget https://a.b/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/curl/i);
  });

  it("returns an error for empty input", () => {
    expect(parseCurl("   ").ok).toBe(false);
  });

  it("returns an error when the URL is missing", () => {
    const result = parseCurl("curl -X POST -H 'A: b'");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/url/i);
  });

  it("returns an error on unterminated quotes", () => {
    expect(parseCurl("curl 'https://a.b/").ok).toBe(false);
  });
});
