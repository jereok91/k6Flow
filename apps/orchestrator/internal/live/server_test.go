package live

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"k6flow/apps/orchestrator/internal/metrics"
	"k6flow/apps/orchestrator/internal/runs"
)

const testToken = "test-service-token"

// fakeLookup is the run-existence dependency standing in for *runs.Store.
type fakeLookup struct {
	mu    sync.RWMutex
	known map[string]bool
}

func (f *fakeLookup) Get(id string) (runs.Run, bool) {
	f.mu.RLock()
	defer f.mu.RUnlock()
	if f.known[id] {
		return runs.Run{ID: id}, true
	}
	return runs.Run{}, false
}

func (f *fakeLookup) add(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.known[id] = true
}

// testEnv is one Server mounted on an httptest server with tracked client
// connections (closed before ts.Close so handler read pumps can exit).
type testEnv struct {
	srv    *Server
	ts     *httptest.Server
	lookup *fakeLookup
	token  string
	mu     sync.Mutex
	conns  []*websocket.Conn
}

func newTestEnv(t *testing.T, mutate ...func(*Deps)) *testEnv {
	t.Helper()
	lookup := &fakeLookup{known: map[string]bool{"run-1": true, "run-2": true}}
	deps := Deps{
		Token:  testToken,
		Lookup: lookup,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	for _, m := range mutate {
		m(&deps)
	}
	srv := New(deps)
	ts := httptest.NewServer(srv.Handler())
	env := &testEnv{srv: srv, ts: ts, lookup: lookup, token: deps.Token}
	t.Cleanup(func() {
		env.mu.Lock()
		for _, c := range env.conns {
			_ = c.Close()
		}
		env.mu.Unlock()
		ts.Close()
	})
	return env
}

func (e *testEnv) wsURL(runID string) string {
	return "ws" + strings.TrimPrefix(e.ts.URL, "http") + "/ws/runs/" + runID
}

func (e *testEnv) track(conn *websocket.Conn) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.conns = append(e.conns, conn)
}

// dialOffer performs the handshake offering the given subprotocol values.
func (e *testEnv) dialOffer(t *testing.T, runID string, header http.Header, protocols ...string) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	d := *websocket.DefaultDialer
	d.Subprotocols = protocols
	conn, resp, err := d.Dial(e.wsURL(runID), header)
	if conn != nil {
		e.track(conn)
	}
	return conn, resp, err
}

// dial subscribes with the standard browser offer [k6flow.bearer, token].
func (e *testEnv) dial(t *testing.T, runID string) *websocket.Conn {
	t.Helper()
	conn, resp, err := e.dialOffer(t, runID, nil, subprotocol, e.token)
	if err != nil {
		t.Fatalf("dial %s: %v (resp=%v)", runID, err, resp)
	}
	return conn
}

// waitSubscribers blocks until the hub registers exactly n subscribers for
// runID (bounded condition wait; fails on timeout).
func (e *testEnv) waitSubscribers(t *testing.T, runID string, n int) {
	t.Helper()
	waitFor(t, fmt.Sprintf("%d subscribers on %s", n, runID), func() bool {
		e.srv.hub.mu.Lock()
		defer e.srv.hub.mu.Unlock()
		return len(e.srv.hub.runs[runID]) == n
	})
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// mkFrame builds a contract-shaped metrics frame identified by its seq.
func mkFrame(runID string, seq int64) metrics.MetricsFrame {
	return metrics.MetricsFrame{
		Version:      1,
		Type:         "metrics",
		RunID:        runID,
		Seq:          seq,
		Window:       metrics.Window{StartMs: seq * 1000, DurationMs: 1000},
		ActiveVUs:    3,
		FailedChecks: 1,
	}
}

func mustEncode(t *testing.T, f metrics.MetricsFrame) []byte {
	t.Helper()
	data, err := f.EncodeJSON()
	if err != nil {
		t.Fatalf("EncodeJSON: %v", err)
	}
	return data
}

// mustEncodeTick wraps a frame in a tick message envelope.
func mustEncodeTick(t *testing.T, f metrics.MetricsFrame) []byte {
	t.Helper()
	tick := NewTickMessage(f)
	data, err := EncodeMessage(tick)
	if err != nil {
		t.Fatalf("EncodeMessage: %v", err)
	}
	return data
}

// skipHello reads and discards the hello message sent on connection.
func skipHello(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read hello: %v", err)
	}
	var probe struct{ Type string `json:"type"` }
	if err := json.Unmarshal(data, &probe); err != nil || probe.Type != TypeHello {
		t.Fatalf("expected hello, got %s", data)
	}
}

func readMessage(t *testing.T, conn *websocket.Conn) []byte {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read message: %v", err)
	}
	return data
}

// drainUntilClose reads messages until the server closes the connection and
// returns the close error; every received message must be a metrics frame
// (no terminal frame exists — deferred capability).
func drainUntilClose(t *testing.T, conn *websocket.Conn) ([][]byte, *websocket.CloseError) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	var msgs [][]byte
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			ce, ok := err.(*websocket.CloseError)
			if !ok {
				t.Fatalf("expected *websocket.CloseError, got %T: %v", err, err)
			}
			return msgs, ce
		}
		msgs = append(msgs, data)
	}
}

func assertMetricsOnly(t *testing.T, msgs [][]byte, runID string, wantIncreasing bool) {
	t.Helper()
	var last int64 = -1
	for _, m := range msgs {
		var probe struct {
			Type string `json:"type"`
			Seq  int64  `json:"seq"`
			Run  string `json:"runId"`
		}
		if err := json.Unmarshal(m, &probe); err != nil {
			t.Fatalf("received non-JSON message %q: %v", m, err)
		}
		// Allow hello and tick messages
		if probe.Type == TypeHello {
			continue // skip hello in assertions
		}
		if probe.Type == TypeTick {
			// Extract seq from tick frame
			var tick struct {
				Frame struct {
					Seq int64 `json:"seq"`
				} `json:"frame"`
			}
			json.Unmarshal(m, &tick)
			probe.Seq = tick.Frame.Seq
		} else if probe.Type != "metrics" {
			t.Fatalf("received non-metrics message type %q (no terminal frame is allowed)", probe.Type)
		}
		if probe.Run != runID {
			t.Fatalf("message for run %q, want %q", probe.Run, runID)
		}
		if wantIncreasing {
			if probe.Seq <= last {
				t.Fatalf("seq out of order: got %d after %d", probe.Seq, last)
			}
			last = probe.Seq
		}
	}
}

// --- auth vectors -----------------------------------------------------------

func TestHandshakeAuthRejections(t *testing.T) {
	cases := []struct {
		name      string
		token     string
		protocols []string
	}{
		{"no header", testToken, nil},
		{"only one value: scheme", testToken, []string{subprotocol}},
		{"only one value: token", testToken, []string{testToken}},
		{"wrong token", testToken, []string{subprotocol, "wrong-token"}},
		{"wrong scheme", testToken, []string{"bearer", testToken}},
		{"empty configured token fails closed", "", []string{subprotocol, testToken}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env := newTestEnv(t, func(d *Deps) { d.Token = tc.token })
			conn, resp, err := env.dialOffer(t, "run-1", nil, tc.protocols...)
			if err == nil {
				_ = conn.Close()
				t.Fatal("handshake unexpectedly succeeded")
			}
			if resp == nil {
				t.Fatal("expected an HTTP response on rejected handshake")
			}
			if resp.StatusCode != http.StatusUnauthorized {
				t.Errorf("status = %d, want %d", resp.StatusCode, http.StatusUnauthorized)
			}
			if got := resp.Header.Get("Sec-WebSocket-Protocol"); got != "" {
				t.Errorf("echoed subprotocol %q on rejected handshake", got)
			}
			if got := resp.Header.Get("Sec-WebSocket-Accept"); got != "" {
				t.Errorf("upgrade headers present on rejected handshake")
			}
		})
	}
}

// dialURL performs a handshake against an explicit URL with no subprotocol
// offer (the browser ticket path).
func (e *testEnv) dialURL(t *testing.T, rawURL string) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	conn, resp, err := websocket.DefaultDialer.Dial(rawURL, nil)
	if conn != nil {
		e.track(conn)
	}
	return conn, resp, err
}

func TestHandshakeAcceptsRunTicket(t *testing.T) {
	env := newTestEnv(t)
	ticket := mintTestTicket("run:run-1", time.Now().Add(time.Minute), "n0nce", testToken)
	conn, resp, err := env.dialURL(t, env.wsURL("run-1")+"?ticket="+url.QueryEscape(ticket))
	if err != nil {
		t.Fatalf("dial with ticket: %v (resp=%v)", err, resp)
	}
	defer conn.Close()
	if got := resp.Header.Get("Sec-WebSocket-Protocol"); got != "" {
		t.Errorf("ticket handshake echoed subprotocol %q, want none", got)
	}
	env.waitSubscribers(t, "run-1", 1)
}

func TestHandshakeTicketRejections(t *testing.T) {
	now := time.Now()
	cases := []struct {
		name   string
		token  string
		ticket string
	}{
		{"ticket for another run", testToken, mintTestTicket("run:run-2", now.Add(time.Minute), "n", testToken)},
		{"expired ticket", testToken, mintTestTicket("run:run-1", now.Add(-time.Minute), "n", testToken)},
		{"ticket signed with wrong key", testToken, mintTestTicket("run:run-1", now.Add(time.Minute), "n", "wrong-key")},
		{"malformed ticket", testToken, "not-a-ticket"},
		{"empty configured token fails closed", "", mintTestTicket("run:run-1", now.Add(time.Minute), "n", "")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env := newTestEnv(t, func(d *Deps) { d.Token = tc.token })
			conn, resp, err := env.dialURL(t, env.wsURL("run-1")+"?ticket="+url.QueryEscape(tc.ticket))
			if err == nil {
				_ = conn.Close()
				t.Fatal("handshake unexpectedly succeeded")
			}
			if resp == nil || resp.StatusCode != http.StatusUnauthorized {
				t.Fatalf("resp = %v, want 401", resp)
			}
		})
	}
}

// The raw service token in the query string is no longer accepted: it
// encouraged shipping the credential to browsers.
func TestHandshakeRejectsServiceTokenQueryParam(t *testing.T) {
	env := newTestEnv(t)
	conn, resp, err := env.dialURL(t, env.wsURL("run-1")+"?token="+url.QueryEscape(testToken))
	if err == nil {
		_ = conn.Close()
		t.Fatal("?token= handshake unexpectedly succeeded")
	}
	if resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("resp = %v, want 401", resp)
	}
}

func TestHandshakeAcceptsValidToken(t *testing.T) {
	env := newTestEnv(t)
	conn, resp, err := env.dialOffer(t, "run-1", nil, subprotocol, testToken)
	if err != nil {
		t.Fatalf("dial: %v (resp=%v)", err, resp)
	}
	defer conn.Close()
	if got := resp.Header.Get("Sec-WebSocket-Protocol"); got != subprotocol {
		t.Errorf("echoed subprotocol = %q, want %q", got, subprotocol)
	}
}

func TestHandshakeAcceptsExtraOfferedValues(t *testing.T) {
	env := newTestEnv(t)
	conn, resp, err := env.dialOffer(t, "run-1", nil, subprotocol, testToken, "chat.example")
	if err != nil {
		t.Fatalf("dial with extra offered values: %v (resp=%v)", err, resp)
	}
	defer conn.Close()
	if got := resp.Header.Get("Sec-WebSocket-Protocol"); got != subprotocol {
		t.Errorf("echoed subprotocol = %q, want %q", got, subprotocol)
	}
}

func TestAuthCheckedBeforeRunExistence(t *testing.T) {
	env := newTestEnv(t)
	// Bad token + unknown run: 401 proves auth precedes the lookup.
	conn, resp, err := env.dialOffer(t, "run-404", nil, subprotocol, "wrong-token")
	if err == nil {
		_ = conn.Close()
		t.Fatal("handshake unexpectedly succeeded")
	}
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("bad-auth unknown-run status = %d, want 401", resp.StatusCode)
	}
	// Good token + unknown run: 404.
	conn, resp, err = env.dialOffer(t, "run-404", nil, subprotocol, testToken)
	if err == nil {
		_ = conn.Close()
		t.Fatal("handshake unexpectedly succeeded")
	}
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("good-auth unknown-run status = %d, want 404", resp.StatusCode)
	}
}

// --- path vectors -----------------------------------------------------------

func TestUnknownRunIDRejected404(t *testing.T) {
	env := newTestEnv(t)
	conn, resp, err := env.dialOffer(t, "run-404", nil, subprotocol, testToken)
	if err == nil {
		_ = conn.Close()
		t.Fatal("handshake unexpectedly succeeded")
	}
	if resp == nil {
		t.Fatal("expected an HTTP response")
	}
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("status = %d, want 404", resp.StatusCode)
	}
	if got := resp.Header.Get("Sec-WebSocket-Accept"); got != "" {
		t.Error("upgrade attempted before run-existence check")
	}
}

func TestBlankAndNestedRunIDAndMethodRejected(t *testing.T) {
	env := newTestEnv(t)
	cases := []struct {
		method, path string
		want         int
	}{
		{http.MethodGet, "/ws/runs/", http.StatusNotFound},
		{http.MethodGet, "/ws/runs/run-1/extra", http.StatusNotFound},
		{http.MethodPost, "/ws/runs/run-1", http.StatusMethodNotAllowed},
	}
	for _, tc := range cases {
		req, err := http.NewRequest(tc.method, env.ts.URL+tc.path, nil)
		if err != nil {
			t.Fatalf("new request: %v", err)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", tc.method, tc.path, err)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
		if resp.StatusCode != tc.want {
			t.Errorf("%s %s: status = %d, want %d", tc.method, tc.path, resp.StatusCode, tc.want)
		}
	}
}

// --- origin policy ----------------------------------------------------------

func TestOriginPolicySameOriginDefault(t *testing.T) {
	env := newTestEnv(t)
	// Same-origin derived from the request Host: allowed.
	conn, resp, err := env.dialOffer(t, "run-1", http.Header{"Origin": []string{env.ts.URL}}, subprotocol, testToken)
	if err != nil {
		t.Fatalf("same-origin dial: %v (resp=%v)", err, resp)
	}
	conn.Close()

	// Absent Origin (non-browser client): allowed.
	conn, resp, err = env.dialOffer(t, "run-1", nil, subprotocol, testToken)
	if err != nil {
		t.Fatalf("absent-origin dial: %v (resp=%v)", err, resp)
	}
	conn.Close()

	// Cross-origin: rejected 403 before the handshake.
	cases := []string{
		"http://evil.example",
		"https://evil.example:8443",
		"null",
	}
	for _, origin := range cases {
		conn, resp, err = env.dialOffer(t, "run-1", http.Header{"Origin": []string{origin}}, subprotocol, testToken)
		if err == nil {
			_ = conn.Close()
			t.Fatalf("origin %q unexpectedly accepted", origin)
		}
		if resp.StatusCode != http.StatusForbidden {
			t.Errorf("origin %q: status = %d, want 403", origin, resp.StatusCode)
		}
	}
}

func TestOriginPolicyExplicitAllowlistReplacesDefault(t *testing.T) {
	const webOrigin = "http://localhost:3000"
	env := newTestEnv(t, func(d *Deps) { d.AllowedOrigins = []string{webOrigin} })

	// Allowlisted origin: allowed.
	conn, resp, err := env.dialOffer(t, "run-1", http.Header{"Origin": []string{webOrigin}}, subprotocol, testToken)
	if err != nil {
		t.Fatalf("allowlisted dial: %v (resp=%v)", err, resp)
	}
	conn.Close()

	// Same-origin (Host-derived) but not allowlisted: rejected — the
	// allowlist replaces the default rather than extending it.
	conn, resp, err = env.dialOffer(t, "run-1", http.Header{"Origin": []string{env.ts.URL}}, subprotocol, testToken)
	if err == nil {
		_ = conn.Close()
		t.Fatal("origin outside allowlist unexpectedly accepted")
	}
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("status = %d, want 403", resp.StatusCode)
	}

	// Absent Origin remains allowed (non-browser client).
	conn, resp, err = env.dialOffer(t, "run-1", nil, subprotocol, testToken)
	if err != nil {
		t.Fatalf("absent-origin dial: %v (resp=%v)", err, resp)
	}
	conn.Close()
}

// --- frame delivery ---------------------------------------------------------

func TestUpgradeDeliversEncodedFrame(t *testing.T) {
	env := newTestEnv(t)
	conn := env.dial(t, "run-1")
	env.waitSubscribers(t, "run-1", 1)
	skipHello(t, conn)

	frame := mkFrame("run-1", 0)
	env.srv.OnFrame(frame)
	got := readMessage(t, conn)
	if want := mustEncodeTick(t, frame); string(got) != string(want) {
		t.Errorf("frame = %s, want %s", got, want)
	}
}

func TestBurstOrderingPreserved(t *testing.T) {
	env := newTestEnv(t)
	conn := env.dial(t, "run-1")
	env.waitSubscribers(t, "run-1", 1)
	skipHello(t, conn)

	// 50 frames < 64-frame buffer: nothing may drop, order must hold.
	const burst = 50
	for i := int64(0); i < burst; i++ {
		env.srv.OnFrame(mkFrame("run-1", i))
	}
	for i := int64(0); i < burst; i++ {
		got := readMessage(t, conn)
		if want := mustEncodeTick(t, mkFrame("run-1", i)); string(got) != string(want) {
			t.Fatalf("frame %d out of order: got %s, want %s", i, got, want)
		}
	}
}

// --- backpressure -----------------------------------------------------------

// TestStalledSubscriberDropOldestNeverBlocks proves the R3 advisory: a
// subscriber whose channel is full (no writer draining it) can neither block
// OnFrame nor evict the newest frame.
func TestStalledSubscriberDropOldestNeverBlocks(t *testing.T) {
	env := newTestEnv(t)
	stalled := &subscriber{
		runID: "run-1",
		hub:   env.srv.hub,
		ch:    make(chan []byte, subscriberBuffer),
		done:  make(chan struct{}),
	}
	env.srv.hub.add(stalled)
	defer stalled.closeWithCode(closeNoFrame)

	const total = 200
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		for i := int64(0); i < total; i++ {
			env.srv.OnFrame(mkFrame("run-1", i))
		}
	}()
	select {
	case <-finished:
	case <-time.After(2 * time.Second):
		t.Fatal("OnFrame blocked on a saturated subscriber")
	}

	if got := len(stalled.ch); got != subscriberBuffer {
		t.Fatalf("buffered frames = %d, want %d", got, subscriberBuffer)
	}
	drained := make([][]byte, 0, subscriberBuffer)
	for len(stalled.ch) > 0 {
		drained = append(drained, <-stalled.ch)
	}
	// Drop-oldest: frames 136..199 survive — latest frame preserved.
	if want := mustEncodeTick(t, mkFrame("run-1", total-subscriberBuffer)); string(drained[0]) != string(want) {
		t.Errorf("oldest surviving frame = %s, want %s", drained[0], want)
	}
	if want := mustEncodeTick(t, mkFrame("run-1", total-1)); string(drained[len(drained)-1]) != string(want) {
		t.Errorf("newest frame = %s, want %s", drained[len(drained)-1], want)
	}
}

func TestStalledSubscriberDoesNotStarveLiveClient(t *testing.T) {
	env := newTestEnv(t)
	stalled := &subscriber{
		runID: "run-1",
		hub:   env.srv.hub,
		ch:    make(chan []byte, subscriberBuffer),
		done:  make(chan struct{}),
	}
	env.srv.hub.add(stalled)
	defer stalled.closeWithCode(closeNoFrame)

	conn := env.dial(t, "run-1")
	env.waitSubscribers(t, "run-1", 2)
	skipHello(t, conn)

	const total = 100
	for i := int64(0); i < total; i++ {
		env.srv.OnFrame(mkFrame("run-1", i))
	}
	// The live client must still receive the newest frame despite the
	// stalled sibling; drops on its own path only require seq monotonicity.
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	var last int64 = -1
	for last != total-1 {
		_, data, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("read: %v (last seq %d)", err, last)
		}
		var probe struct {
			Type  string `json:"type"`
			Seq   int64  `json:"seq"`
			Frame struct {
				Seq int64 `json:"seq"`
			} `json:"frame"`
		}
		if err := json.Unmarshal(data, &probe); err != nil {
			t.Fatalf("parse: %v", err)
		}
		// Use frame.seq for tick messages
		seq := probe.Seq
		if probe.Type == TypeTick {
			seq = probe.Frame.Seq
		}
		if seq <= last {
			t.Fatalf("seq out of order: %d after %d", seq, last)
		}
		last = seq
	}
}

// --- read-side policy -------------------------------------------------------

func TestClientPingAnsweredWithPong(t *testing.T) {
	env := newTestEnv(t)
	conn := env.dial(t, "run-1")
	pong := make(chan struct{}, 1)
	conn.SetPongHandler(func(string) error {
		select {
		case pong <- struct{}{}:
		default:
		}
		return nil
	})
	// Reading must run to process control frames.
	go func() {
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()
	if err := conn.WriteControl(websocket.PingMessage, []byte("hi"), time.Now().Add(3*time.Second)); err != nil {
		t.Fatalf("write ping: %v", err)
	}
	select {
	case <-pong:
	case <-time.After(3 * time.Second):
		t.Fatal("server did not answer ping with pong")
	}
}

func TestClientCloseUnregistersSubscriber(t *testing.T) {
	env := newTestEnv(t)
	conn := env.dial(t, "run-1")
	env.waitSubscribers(t, "run-1", 1)

	if err := conn.WriteControl(
		websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""),
		time.Now().Add(3*time.Second),
	); err != nil {
		t.Fatalf("write close: %v", err)
	}
	waitFor(t, "subscriber unregistered after client close", func() bool {
		env.srv.hub.mu.Lock()
		defer env.srv.hub.mu.Unlock()
		return len(env.srv.hub.runs["run-1"]) == 0
	})
}

// --- lifecycle --------------------------------------------------------------

func TestCloseRunSendsEmpty1000AndCleansRegistry(t *testing.T) {
	env := newTestEnv(t)
	a1 := env.dial(t, "run-1")
	a2 := env.dial(t, "run-1")
	b := env.dial(t, "run-2")
	env.waitSubscribers(t, "run-1", 2)
	env.waitSubscribers(t, "run-2", 1)

	// A queued frame must arrive before the close, metrics-only.
	env.srv.OnFrame(mkFrame("run-1", 0))

	env.srv.CloseRun("run-1", websocket.CloseNormalClosure)

	// Registry cleaned synchronously for run-1; run-2 untouched.
	env.srv.hub.mu.Lock()
	_, run1Present := env.srv.hub.runs["run-1"]
	run2Count := len(env.srv.hub.runs["run-2"])
	env.srv.hub.mu.Unlock()
	if run1Present {
		t.Error("run-1 still present in hub registry after CloseRun")
	}
	if run2Count != 1 {
		t.Errorf("run-2 subscribers = %d, want 1", run2Count)
	}

	for _, conn := range []*websocket.Conn{a1, a2} {
		msgs, ce := drainUntilClose(t, conn)
		assertMetricsOnly(t, msgs, "run-1", true)
		if ce.Code != websocket.CloseNormalClosure {
			t.Errorf("close code = %d, want 1000", ce.Code)
		}
		if ce.Text != "" {
			t.Errorf("close reason = %q, want empty (no terminal frame, empty reason)", ce.Text)
		}
	}

	// The other run's subscriber is unaffected and still receives frames.
	skipHello(t, b) // skip hello message
	env.srv.OnFrame(mkFrame("run-2", 7))
	if got := readMessage(t, b); string(got) != string(mustEncodeTick(t, mkFrame("run-2", 7))) {
		t.Errorf("run-2 frame = %s, want seq 7 frame", got)
	}
}

func TestCloseAllClosesEverySubscriber(t *testing.T) {
	env := newTestEnv(t)
	a := env.dial(t, "run-1")
	b := env.dial(t, "run-2")
	env.waitSubscribers(t, "run-1", 1)
	env.waitSubscribers(t, "run-2", 1)

	env.srv.CloseAll(websocket.CloseNormalClosure)

	for name, conn := range map[string]*websocket.Conn{"run-1": a, "run-2": b} {
		_, ce := drainUntilClose(t, conn)
		if ce.Code != websocket.CloseNormalClosure || ce.Text != "" {
			t.Errorf("%s: close = (%d, %q), want (1000, \"\")", name, ce.Code, ce.Text)
		}
	}
	env.srv.hub.mu.Lock()
	remaining := len(env.srv.hub.runs)
	env.srv.hub.mu.Unlock()
	if remaining != 0 {
		t.Errorf("hub still holds %d runs after CloseAll", remaining)
	}
}

// --- write-error path -------------------------------------------------------

// firstSub returns the first registered subscriber of runID (test seam into
// the registry; fails if none is registered).
func (e *testEnv) firstSub(t *testing.T, runID string) *subscriber {
	t.Helper()
	var sub *subscriber
	waitFor(t, "a subscriber on "+runID, func() bool {
		e.srv.hub.mu.Lock()
		defer e.srv.hub.mu.Unlock()
		for s := range e.srv.hub.runs[runID] {
			sub = s
			return true
		}
		return false
	})
	return sub
}

func TestWriteFailureUnregistersSubscriber(t *testing.T) {
	env := newTestEnv(t)
	env.dial(t, "run-1")
	env.waitSubscribers(t, "run-1", 1)

	sub := env.firstSub(t, "run-1")

	// Cut the TCP connection underneath the writer.
	_ = sub.conn.NetConn().Close()
	env.srv.OnFrame(mkFrame("run-1", 0))

	waitFor(t, "subscriber unregistered after write failure", func() bool {
		env.srv.hub.mu.Lock()
		defer env.srv.hub.mu.Unlock()
		return len(env.srv.hub.runs["run-1"]) == 0
	})
	select {
	case <-sub.done:
	case <-time.After(3 * time.Second):
		t.Fatal("done channel not closed after write failure")
	}
}

func TestCloseWithInternalErrorDelivers1011(t *testing.T) {
	env := newTestEnv(t)
	conn := env.dial(t, "run-1")
	env.waitSubscribers(t, "run-1", 1)

	sub := env.firstSub(t, "run-1")

	// The close path used for unknown-frame write errors (1011, empty reason).
	sub.closeWithCode(closeInternalError)
	_, ce := drainUntilClose(t, conn)
	if ce.Code != websocket.CloseInternalServerErr || ce.Text != "" {
		t.Errorf("close = (%d, %q), want (1011, \"\")", ce.Code, ce.Text)
	}
}

// --- concurrency ------------------------------------------------------------

// TestCloseRunDuringBurst holds the single-writer invariant: the connection
// writer and the CloseRun control frame race under -race, every delivered
// message must stay a well-formed, in-order metrics frame, and the
// connection must end with an empty 1000.
func TestCloseRunDuringBurst(t *testing.T) {
	env := newTestEnv(t)
	conn := env.dial(t, "run-1")
	env.waitSubscribers(t, "run-1", 1)

	burstDone := make(chan struct{})
	go func() {
		defer close(burstDone)
		for i := int64(0); i < 2000; i++ {
			env.srv.OnFrame(mkFrame("run-1", i))
		}
	}()

	env.srv.CloseRun("run-1", websocket.CloseNormalClosure)
	msgs, ce := drainUntilClose(t, conn)
	<-burstDone
	assertMetricsOnly(t, msgs, "run-1", true)
	if ce.Code != websocket.CloseNormalClosure || ce.Text != "" {
		t.Errorf("close = (%d, %q), want (1000, \"\")", ce.Code, ce.Text)
	}
}

// TestConcurrentSubscribeBroadcastCloseStorm churns subscriptions,
// broadcasts and closes concurrently; correctness is -race cleanliness, no
// deadlock and an empty registry at the end.
func TestConcurrentSubscribeBroadcastCloseStorm(t *testing.T) {
	env := newTestEnv(t)
	stop := make(chan struct{})
	var drivers sync.WaitGroup

	// Broadcaster.
	drivers.Add(1)
	go func() {
		defer drivers.Done()
		var seq int64
		for {
			select {
			case <-stop:
				return
			default:
			}
			env.srv.OnFrame(mkFrame("run-1", seq))
			seq++
			time.Sleep(time.Millisecond)
		}
	}()

	// Closer.
	drivers.Add(1)
	go func() {
		defer drivers.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			env.srv.CloseRun("run-1", websocket.CloseNormalClosure)
			time.Sleep(time.Millisecond)
		}
	}()

	// Workers: subscribe, drain briefly, disconnect.
	var workers sync.WaitGroup
	for w := 0; w < 4; w++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for i := 0; i < 25; i++ {
				conn, _, err := env.dialOffer(t, "run-1", nil, subprotocol, env.token)
				if err != nil {
					continue
				}
				_ = conn.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
				for {
					if _, _, err := conn.ReadMessage(); err != nil {
						break
					}
				}
				_ = conn.Close()
			}
		}()
	}

	workers.Wait()
	close(stop)
	drivers.Wait()

	env.srv.CloseAll(websocket.CloseNormalClosure)
	waitFor(t, "empty hub registry after storm", func() bool {
		env.srv.hub.mu.Lock()
		defer env.srv.hub.mu.Unlock()
		return len(env.srv.hub.runs) == 0
	})
}
