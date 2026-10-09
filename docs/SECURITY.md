# K6Flow Security Documentation

## Overview

K6Flow includes security features to protect against common vulnerabilities when running browser-based recording sessions.

## Network Isolation (SSRF Protection)

The `network-isolation` module prevents Server-Side Request Forgery (SSRF) attacks.

### Protected Ranges

- **RFC 1918 Private Ranges**: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
- **Localhost**: 127.0.0.0/8, ::1
- **Link-Local**: 169.254.0.0/16
- **Cloud Metadata Endpoints**:
  - AWS/GCP/Azure: 169.254.169.254
  - Google Internal: metadata.google.internal
  - Alibaba: 100.100.100.200

### Usage

```typescript
import { validateUrl, createUrlValidator } from '@k6flow/shared';

// Simple validation
const result = validateUrl("http://169.254.169.254/metadata");
// { allowed: false, reason: "Private/internal network access blocked" }

// Custom validator with domain allowlist
const validator = createUrlValidator({
  blockPrivateRanges: true,
  blockMetadata: true,
  allowedDomains: ["example.com", "api.example.com"]
});
```

## Data Redaction

The `data-redaction` module automatically masks sensitive data before persistence.

### Redacted Fields

- Authentication: password, token, api_key, authorization, bearer
- Credentials: secret, credential, private_key
- Financial: credit_card, card_number, cvv, bank_account, ssn

### Redacted Patterns

- JWT tokens: `eyJ...` → `[REDACTED_JWT]`
- Bearer tokens: `Bearer xxx` → `Bearer [REDACTED]`
- Credit cards: `1234-5678-9012-3456` → `[REDACTED_CARD]`
- SSN: `123-45-6789` → `[REDACTED_SSN]`

### Usage

```typescript
import { redactCapture, redactJsonBody, redactHeaders } from '@k6flow/shared';

// Redact full HTTP capture
const safeCapture = redactCapture({
  url: "https://api.example.com/login?api_key=secret123",
  method: "POST",
  headers: [{ name: "Authorization", value: "Bearer eyJ..." }],
  body: JSON.stringify({ password: "secret" })
});

// Redact JSON body
const safeBody = redactJsonBody({ username: "user", password: "secret" });
// { username: "user", password: "[REDACTED]" }
```

## Browser State Encryption

Browser states (cookies, localStorage) are:
- Stored with automatic expiration (default: 24 hours)
- Associated with specific user accounts
- Deletable by the user at any time

Future enhancement: AES-256 encryption at rest.

## Recording Security

### Container Isolation

- Each recording session runs in an isolated Playwright browser context
- Sessions are destroyed on disconnect or timeout
- No persistent browser state between sessions

### Session Limits

- Configurable maximum recording duration
- Configurable maximum concurrent recordings per user
- Automatic cleanup of orphaned sessions

## API Security

### Authentication

- All API endpoints require session authentication
- Session tokens are HTTP-only cookies
- Passwords are hashed with Argon2id

### Authorization

- Users can only access their own resources
- Admin role can access all resources
- Resource ownership is verified on every request

### Live metrics WebSocket (browser auth)

The orchestrator service token (`ORCHESTRATOR_SERVICE_TOKEN`) is a server-side credential. It
is **never sent to browsers**, never embedded in client code and never placed in a URL.

Browsers authenticate the live metrics socket with short-lived signed tickets:

1. Before each connect or reconnect, the browser calls
   `GET /api/orchestrator/ws-ticket?runId=...`. The route requires a session (401) and run
   ownership (403, fail-closed when ownership is unknown).
2. The route returns `{ ticket, expiresAt }`. The ticket is an HMAC-SHA256 signature over
   `v1.<scope>.<exp>.<nonce>`, keyed with the service token. It is scoped to one run
   (`run:<runId>`) and expires after 60 seconds.
3. The browser opens the same-origin `/api/ws/runs/{runId}?ticket=...`. It never connects to
   the orchestrator port directly.
4. The orchestrator verifies the signature in constant time, the expiry (5 s skew allowance)
   and the exact scope before the upgrade. An empty configured secret fails closed.

A leaked ticket opens only that run's stream, for at most about a minute. An already-open
socket is not cut when its ticket expires. Server-side clients keep the
`Sec-WebSocket-Protocol: k6flow.bearer, <token>` handshake. The `?token=<service token>`
query parameter is no longer accepted. Contract details: [api/ws-metrics.md](api/ws-metrics.md).

## Recommendations

1. **Deploy behind reverse proxy**: Use Caddy/nginx for TLS termination
2. **Set strong session secrets**: Use cryptographically random values
3. **Enable rate limiting**: Configure at reverse proxy level
4. **Monitor recording sessions**: Check for abuse patterns
5. **Regular cleanup**: Run orphan container reconciliation
6. **Update dependencies**: Keep Playwright and Node.js updated

## Reporting Security Issues

Please report security vulnerabilities responsibly by contacting the maintainers directly.
