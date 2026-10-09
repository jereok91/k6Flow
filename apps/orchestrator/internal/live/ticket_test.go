package live

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strconv"
	"strings"
	"testing"
	"time"
)

const ticketTestSecret = "ticket-test-secret"

// mintTestTicket is a test-only minter mirroring apps/web/lib/orchestrator/
// ws-ticket.ts (the orchestrator itself never mints tickets).
func mintTestTicket(scope string, exp time.Time, nonce, secret string) string {
	signed := "v1." + scope + "." + strconv.FormatInt(exp.Unix(), 10) + "." + nonce
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(signed))
	return signed + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func TestVerifyTicketValid(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	ticket := mintTestTicket("run:run-1", now.Add(60*time.Second), "bm9uY2U", ticketTestSecret)
	if err := VerifyTicket(ticket, ticketTestSecret, "run:run-1", now); err != nil {
		t.Fatalf("valid ticket rejected: %v", err)
	}
}

// Cross-language vector: produced by node:crypto with the exact algorithm of
// mintWsTicket (apps/web/lib/orchestrator/ws-ticket.test.ts asserts the same).
func TestVerifyTicketCrossLanguageVector(t *testing.T) {
	const vector = "v1.run:run-42.1700000060.AAECAwQFBgcICQoLDA0ODw.gXTz68PGLwUpGIZCYaGFyMGyJlRHItmua6Lg9Wmm7B4"
	if err := VerifyTicket(vector, "fixture-secret", "run:run-42", time.Unix(1_700_000_000, 0)); err != nil {
		t.Fatalf("node-minted vector rejected: %v", err)
	}
}

func TestVerifyTicketExpiry(t *testing.T) {
	exp := time.Unix(1_700_000_060, 0)
	ticket := mintTestTicket("run:run-1", exp, "n", ticketTestSecret)

	// Within the 5s clock-skew allowance: still accepted.
	if err := VerifyTicket(ticket, ticketTestSecret, "run:run-1", exp.Add(5*time.Second)); err != nil {
		t.Errorf("ticket within skew rejected: %v", err)
	}
	// Past the skew allowance: expired.
	err := VerifyTicket(ticket, ticketTestSecret, "run:run-1", exp.Add(6*time.Second))
	if !errors.Is(err, ErrTicketExpired) {
		t.Errorf("err = %v, want ErrTicketExpired", err)
	}
}

func TestVerifyTicketTamperedSignature(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	ticket := mintTestTicket("run:run-1", now.Add(time.Minute), "n", ticketTestSecret)

	cases := map[string]string{
		"flipped sig char": flipLast(ticket),
		"scope swapped":    strings.Replace(ticket, "run:run-1", "run:run-2", 1),
		"exp extended":     strings.Replace(ticket, strconv.FormatInt(now.Add(time.Minute).Unix(), 10), strconv.FormatInt(now.Add(time.Hour).Unix(), 10), 1),
		"wrong secret":     mintTestTicket("run:run-1", now.Add(time.Minute), "n", "other-secret"),
	}
	for name, tk := range cases {
		t.Run(name, func(t *testing.T) {
			wantScope := "run:run-1"
			if name == "scope swapped" {
				wantScope = "run:run-2"
			}
			err := VerifyTicket(tk, ticketTestSecret, wantScope, now)
			if !errors.Is(err, ErrTicketSignature) {
				t.Errorf("err = %v, want ErrTicketSignature", err)
			}
		})
	}
}

func TestVerifyTicketWrongScope(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	ticket := mintTestTicket("run:run-1", now.Add(time.Minute), "n", ticketTestSecret)
	for _, want := range []string{"run:run-2", "run:run-", "run:run-10", "runs", ""} {
		err := VerifyTicket(ticket, ticketTestSecret, want, now)
		if !errors.Is(err, ErrTicketScope) {
			t.Errorf("want scope %q: err = %v, want ErrTicketScope", want, err)
		}
	}
}

func TestVerifyTicketMalformed(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	sign := func(signed string) string {
		mac := hmac.New(sha256.New, []byte(ticketTestSecret))
		mac.Write([]byte(signed))
		return signed + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	}
	cases := map[string]string{
		"empty":           "",
		"no dots":         "garbage",
		"too few parts":   "v1.run:run-1.1700000060",
		"wrong version":   sign("v2.run:run-1.1700000060.n"),
		"non-numeric exp": sign("v1.run:run-1.soon.n"),
		"negative exp":    sign("v1.run:run-1.-5.n"),
		"empty scope":     sign("v1..1700000060.n"),
		"empty nonce":     sign("v1.run:run-1.1700000060."),
		"sig not base64":  "v1.run:run-1.1700000060.n.!!!",
		"empty signature": "v1.run:run-1.1700000060.n.",
	}
	for name, tk := range cases {
		t.Run(name, func(t *testing.T) {
			err := VerifyTicket(tk, ticketTestSecret, "run:run-1", now)
			if err == nil {
				t.Fatal("malformed ticket accepted")
			}
			if !errors.Is(err, ErrTicketMalformed) && !errors.Is(err, ErrTicketSignature) {
				t.Errorf("err = %v, want ErrTicketMalformed or ErrTicketSignature", err)
			}
		})
	}
}

func TestVerifyTicketEmptySecretFailsClosed(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	// A ticket "signed" with the empty key must not verify against an empty secret.
	ticket := mintTestTicket("run:run-1", now.Add(time.Minute), "n", "")
	err := VerifyTicket(ticket, "", "run:run-1", now)
	if !errors.Is(err, ErrTicketNoSecret) {
		t.Errorf("err = %v, want ErrTicketNoSecret", err)
	}
}

func flipLast(s string) string {
	last := s[len(s)-1]
	repl := byte('A')
	if last == 'A' {
		repl = 'B'
	}
	return s[:len(s)-1] + string(repl)
}
