package live

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"k6flow/apps/orchestrator/internal/runs"
)

// fakeLister stands in for *runs.Store's List for the global runs feed.
type fakeLister struct {
	mu   sync.Mutex
	runs []runs.Run
}

func (f *fakeLister) List() []runs.Run {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]runs.Run(nil), f.runs...)
}

func newFeedEnv(t *testing.T, list []runs.Run, mutate ...func(*Deps)) *testEnv {
	t.Helper()
	lister := &fakeLister{runs: list}
	all := append([]func(*Deps){func(d *Deps) { d.Runs = lister }}, mutate...)
	return newTestEnv(t, all...)
}

func (e *testEnv) feedURL() string {
	return "ws" + strings.TrimPrefix(e.ts.URL, "http") + "/ws/runs"
}

func (e *testEnv) dialFeed(t *testing.T) *websocket.Conn {
	t.Helper()
	d := *websocket.DefaultDialer
	d.Subprotocols = []string{subprotocol, e.token}
	conn, resp, err := d.Dial(e.feedURL(), nil)
	if err != nil {
		t.Fatalf("dial feed: %v (resp=%v)", err, resp)
	}
	e.track(conn)
	return conn
}

func (e *testEnv) waitFeedSubscribers(t *testing.T, n int) {
	t.Helper()
	waitFor(t, "feed subscribers", func() bool { return e.srv.feed.count() == n })
}

type feedItem struct {
	ID           string `json:"id"`
	Status       string `json:"status"`
	ScenarioID   string `json:"scenarioId"`
	ScenarioName string `json:"scenarioName"`
	VUs          int    `json:"vus"`
	DurationMs   int    `json:"durationMs"`
	CreatedAt    int64  `json:"createdAt"`
	StartedAt    *int64 `json:"startedAt"`
}

type feedMsg struct {
	Version   int        `json:"version"`
	Type      string     `json:"type"`
	Active    []feedItem `json:"active"`
	Queued    []feedItem `json:"queued"`
	Run       *feedItem  `json:"run"`
	FromState string     `json:"fromState"`
	ToState   string     `json:"toState"`
	At        int64      `json:"at"`
	Status    string     `json:"status"`
	ExitCode  *int       `json:"exitCode"`
}

func readFeed(t *testing.T, conn *websocket.Conn) feedMsg {
	t.Helper()
	data := readMessage(t, conn)
	var msg feedMsg
	if err := json.Unmarshal(data, &msg); err != nil {
		t.Fatalf("decode feed message %s: %v", data, err)
	}
	if msg.Version != 1 {
		t.Fatalf("version = %d, want 1 (%s)", msg.Version, data)
	}
	return msg
}

func TestRunsFeedSnapshotOnConnect(t *testing.T) {
	created := time.UnixMilli(1_700_000_000_000)
	started := created.Add(time.Second)
	env := newFeedEnv(t, []runs.Run{
		{ID: "run-a", Status: runs.StatusRunning, ScenarioID: "sc-1", ScenarioName: "Login", VUs: 5, DurationMs: 30000, CreatedAt: created, StartedAt: &started},
		{ID: "run-q", Status: runs.StatusQueued, VUs: 1, DurationMs: 1000, CreatedAt: created},
		{ID: "run-done", Status: runs.StatusFinished, CreatedAt: created},
	})
	conn := env.dialFeed(t)
	msg := readFeed(t, conn)
	if msg.Type != "runs.snapshot" {
		t.Fatalf("type = %q, want runs.snapshot", msg.Type)
	}
	if len(msg.Active) != 1 || msg.Active[0].ID != "run-a" {
		t.Fatalf("active = %+v, want [run-a]", msg.Active)
	}
	a := msg.Active[0]
	if a.Status != "running" || a.ScenarioName != "Login" || a.ScenarioID != "sc-1" || a.VUs != 5 ||
		a.DurationMs != 30000 || a.CreatedAt != created.UnixMilli() || a.StartedAt == nil || *a.StartedAt != started.UnixMilli() {
		t.Errorf("active item = %+v", a)
	}
	if len(msg.Queued) != 1 || msg.Queued[0].ID != "run-q" {
		t.Fatalf("queued = %+v, want [run-q]", msg.Queued)
	}
}

func TestRunsFeedEmptySnapshotUsesArrays(t *testing.T) {
	env := newFeedEnv(t, nil)
	conn := env.dialFeed(t)
	data := readMessage(t, conn)
	if !strings.Contains(string(data), `"active":[]`) || !strings.Contains(string(data), `"queued":[]`) {
		t.Fatalf("empty snapshot = %s, want empty arrays", data)
	}
}

func TestRunsFeedStateEventDelivered(t *testing.T) {
	env := newFeedEnv(t, nil)
	conn := env.dialFeed(t)
	_ = readFeed(t, conn) // snapshot
	env.waitFeedSubscribers(t, 1)

	at := time.UnixMilli(1_700_000_005_000)
	env.srv.PublishRunState(runs.Run{ID: "run-1", Status: runs.StatusRunning, VUs: 2, CreatedAt: at}, runs.StatusPending, runs.StatusRunning, at)
	msg := readFeed(t, conn)
	if msg.Type != "runs.state" {
		t.Fatalf("type = %q, want runs.state", msg.Type)
	}
	if msg.Run == nil || msg.Run.ID != "run-1" || msg.Run.Status != "running" || msg.Run.VUs != 2 {
		t.Fatalf("run = %+v", msg.Run)
	}
	if msg.FromState != "pending" || msg.ToState != "running" || msg.At != at.UnixMilli() {
		t.Fatalf("transition = %s->%s at %d", msg.FromState, msg.ToState, msg.At)
	}
}

func TestRunsFeedCreationStateHasEmptyFrom(t *testing.T) {
	env := newFeedEnv(t, nil)
	conn := env.dialFeed(t)
	_ = readFeed(t, conn)
	env.waitFeedSubscribers(t, 1)
	now := time.Now()
	env.srv.PublishRunState(runs.Run{ID: "run-new", Status: runs.StatusPending, CreatedAt: now}, "", runs.StatusPending, now)
	msg := readFeed(t, conn)
	if msg.Type != "runs.state" || msg.FromState != "" || msg.ToState != "pending" || msg.Run.ID != "run-new" {
		t.Fatalf("creation event = %+v", msg)
	}
}

func TestRunsFeedEndEventDelivered(t *testing.T) {
	env := newFeedEnv(t, nil)
	conn := env.dialFeed(t)
	_ = readFeed(t, conn)
	env.waitFeedSubscribers(t, 1)

	env.srv.PublishRunEnd(runs.Run{ID: "run-1", Status: runs.StatusFailed, ExitCode: 99})
	msg := readFeed(t, conn)
	if msg.Type != "runs.end" {
		t.Fatalf("type = %q, want runs.end", msg.Type)
	}
	if msg.Run == nil || msg.Run.ID != "run-1" || msg.Status != "failed" || msg.ExitCode == nil || *msg.ExitCode != 99 {
		t.Fatalf("end = %+v", msg)
	}
}

func TestRunsFeedTicketScope(t *testing.T) {
	now := time.Now()
	t.Run("runs scope accepted", func(t *testing.T) {
		env := newFeedEnv(t, nil)
		ticket := mintTestTicket(RunsTicketScope, now.Add(time.Minute), "n", testToken)
		conn, resp, err := env.dialURL(t, env.feedURL()+"?ticket="+url.QueryEscape(ticket))
		if err != nil {
			t.Fatalf("dial feed with runs ticket: %v (resp=%v)", err, resp)
		}
		if msg := readFeed(t, conn); msg.Type != "runs.snapshot" {
			t.Fatalf("first message = %q, want runs.snapshot", msg.Type)
		}
	})
	rejected := map[string]string{
		"run scope rejected":      mintTestTicket("run:x", now.Add(time.Minute), "n", testToken),
		"expired runs rejected":   mintTestTicket(RunsTicketScope, now.Add(-time.Minute), "n", testToken),
		"wrong key runs rejected": mintTestTicket(RunsTicketScope, now.Add(time.Minute), "n", "wrong"),
		"malformed ticket":        "nope",
	}
	for name, ticket := range rejected {
		t.Run(name, func(t *testing.T) {
			env := newFeedEnv(t, nil)
			conn, resp, err := env.dialURL(t, env.feedURL()+"?ticket="+url.QueryEscape(ticket))
			if err == nil {
				_ = conn.Close()
				t.Fatal("handshake unexpectedly succeeded")
			}
			if resp == nil || resp.StatusCode != http.StatusUnauthorized {
				t.Fatalf("resp = %v, want 401", resp)
			}
		})
	}
	t.Run("runs ticket does not open a per-run socket", func(t *testing.T) {
		env := newFeedEnv(t, nil)
		ticket := mintTestTicket(RunsTicketScope, now.Add(time.Minute), "n", testToken)
		conn, resp, err := env.dialURL(t, env.wsURL("run-1")+"?ticket="+url.QueryEscape(ticket))
		if err == nil {
			_ = conn.Close()
			t.Fatal("per-run handshake accepted a runs ticket")
		}
		if resp == nil || resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("resp = %v, want 401", resp)
		}
	})
	t.Run("no credentials rejected", func(t *testing.T) {
		env := newFeedEnv(t, nil)
		conn, resp, err := env.dialURL(t, env.feedURL())
		if err == nil {
			_ = conn.Close()
			t.Fatal("handshake unexpectedly succeeded")
		}
		if resp == nil || resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("resp = %v, want 401", resp)
		}
	})
}

func TestRunsFeedRejectsForeignOrigin(t *testing.T) {
	env := newFeedEnv(t, nil)
	d := *websocket.DefaultDialer
	d.Subprotocols = []string{subprotocol, env.token}
	conn, resp, err := d.Dial(env.feedURL(), http.Header{"Origin": {"https://evil.example"}})
	if err == nil {
		_ = conn.Close()
		t.Fatal("foreign origin accepted")
	}
	if resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("resp = %v, want 403", resp)
	}
}

// A subscriber whose buffer is full is dropped (closed) instead of blocking
// the publisher; publishes keep returning promptly.
func TestRunsFeedSlowSubscriberDroppedWithoutBlocking(t *testing.T) {
	env := newFeedEnv(t, nil)
	slow := newFeedSubscriber(env.srv.feed, nil)
	if !env.srv.feed.add(slow) {
		t.Fatal("add slow subscriber rejected")
	}
	// healthy is drained synchronously after every publish (deterministic).
	healthy := newFeedSubscriber(env.srv.feed, nil)
	if !env.srv.feed.add(healthy) {
		t.Fatal("add healthy subscriber rejected")
	}
	env.waitFeedSubscribers(t, 2)

	start := time.Now()
	for i := 0; i < subscriberBuffer+1; i++ {
		env.srv.PublishRunState(runs.Run{ID: "run-1", Status: runs.StatusRunning}, runs.StatusPending, runs.StatusRunning, time.Now())
		select {
		case data := <-healthy.ch:
			if !strings.Contains(string(data), `"type":"runs.state"`) {
				t.Fatalf("healthy got %s", data)
			}
		default:
			t.Fatalf("healthy subscriber missed event %d", i)
		}
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("publishing blocked for %v", elapsed)
	}
	select {
	case <-slow.done:
	case <-time.After(3 * time.Second):
		t.Fatal("slow subscriber was not dropped")
	}
	env.waitFeedSubscribers(t, 1)
	select {
	case <-healthy.done:
		t.Fatal("healthy subscriber was closed")
	default:
	}
}

func TestRunsFeedSubscriberCapClosesExtrasWithPolicyCode(t *testing.T) {
	env := newFeedEnv(t, nil, func(d *Deps) { d.MaxRunsSubscribers = 1 })
	first := env.dialFeed(t)
	_ = readFeed(t, first)
	env.waitFeedSubscribers(t, 1)

	extra := env.dialFeed(t)
	_ = extra.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, _, err := extra.ReadMessage()
	ce, ok := err.(*websocket.CloseError)
	if !ok || ce.Code != websocket.ClosePolicyViolation {
		t.Fatalf("extra subscriber err = %v, want close 1008", err)
	}
	if n := env.srv.feed.count(); n != 1 {
		t.Fatalf("feed subscribers = %d, want 1", n)
	}
}

func TestRunsFeedClientCloseUnregisters(t *testing.T) {
	env := newFeedEnv(t, nil)
	conn := env.dialFeed(t)
	_ = readFeed(t, conn)
	env.waitFeedSubscribers(t, 1)
	_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(time.Second))
	_ = conn.Close()
	env.waitFeedSubscribers(t, 0)
}

func TestCloseAllClosesFeedSubscribers(t *testing.T) {
	env := newFeedEnv(t, nil)
	conn := env.dialFeed(t)
	_ = readFeed(t, conn)
	env.waitFeedSubscribers(t, 1)
	env.srv.CloseAll(websocket.CloseNormalClosure)
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, _, err := conn.ReadMessage()
	if ce, ok := err.(*websocket.CloseError); !ok || ce.Code != websocket.CloseNormalClosure {
		t.Fatalf("err = %v, want close 1000", err)
	}
	env.waitFeedSubscribers(t, 0)
}
