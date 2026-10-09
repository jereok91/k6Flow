package live

// Short-lived WebSocket handshake tickets (browser auth).
//
// Browsers cannot set Authorization headers on a WebSocket handshake and the
// service token must never reach them, so the web app mints a short-lived,
// scoped ticket server-side (apps/web/lib/orchestrator/ws-ticket.ts, after the
// user's session and run ownership are checked) and the browser presents it
// as `?ticket=` on the same-origin `/api/ws/...` proxy path.
//
// Format: v1.<scope>.<expUnixSeconds>.<nonce>.<sigBase64url>
//   - scope: e.g. "run:<runId>"; compared exactly against the scope derived
//     from the requested path.
//   - sig: unpadded base64url HMAC-SHA256, keyed with the shared service
//     token, over the literal prefix "v1.<scope>.<exp>.<nonce>".
//
// The ticket only gates the handshake: an established socket is not cut when
// the ticket expires. An empty secret fails closed.

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strconv"
	"strings"
	"time"
)

const (
	ticketVersion = "v1"
	// ticketClockSkew tolerates small clock drift between the web minter
	// and the orchestrator verifier.
	ticketClockSkew = 5 * time.Second
)

// Ticket verification errors (callers map all of them to HTTP 401).
var (
	ErrTicketNoSecret  = errors.New("ticket: no secret configured")
	ErrTicketMalformed = errors.New("ticket: malformed")
	ErrTicketSignature = errors.New("ticket: bad signature")
	ErrTicketExpired   = errors.New("ticket: expired")
	ErrTicketScope     = errors.New("ticket: scope mismatch")
)

// RunTicketScope is the ticket scope that authorizes /ws/runs/{runId}.
func RunTicketScope(runID string) string {
	return "run:" + runID
}

// VerifyTicket checks format, the constant-time HMAC signature, expiry (with
// ticketClockSkew allowance) and an exact scope match, in that order: the
// signature is verified before any signed field is trusted.
func VerifyTicket(ticket, secret, wantScope string, now time.Time) error {
	if secret == "" {
		return ErrTicketNoSecret
	}
	cut := strings.LastIndexByte(ticket, '.')
	if cut <= 0 || cut == len(ticket)-1 {
		return ErrTicketMalformed
	}
	signed, sigPart := ticket[:cut], ticket[cut+1:]
	sig, err := base64.RawURLEncoding.Strict().DecodeString(sigPart)
	if err != nil || len(sig) != sha256.Size {
		return ErrTicketMalformed
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(signed))
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return ErrTicketSignature
	}

	// Signed prefix: v1.<scope>.<exp>.<nonce>. The scope is everything between
	// the version and the last two fields, so it may itself contain dots.
	if !strings.HasPrefix(signed, ticketVersion+".") {
		return ErrTicketMalformed
	}
	rest := signed[len(ticketVersion)+1:]
	nonceCut := strings.LastIndexByte(rest, '.')
	if nonceCut < 0 {
		return ErrTicketMalformed
	}
	nonce := rest[nonceCut+1:]
	rest = rest[:nonceCut]
	expCut := strings.LastIndexByte(rest, '.')
	if expCut < 0 {
		return ErrTicketMalformed
	}
	scope, expPart := rest[:expCut], rest[expCut+1:]
	if scope == "" || nonce == "" || expPart == "" {
		return ErrTicketMalformed
	}
	exp, err := strconv.ParseInt(expPart, 10, 64)
	if err != nil || exp < 0 || expPart[0] == '+' {
		return ErrTicketMalformed
	}
	if now.After(time.Unix(exp, 0).Add(ticketClockSkew)) {
		return ErrTicketExpired
	}
	if wantScope == "" || scope != wantScope {
		return ErrTicketScope
	}
	return nil
}
