package live

// Global runs feed: `GET /ws/runs` pushes run lifecycle events so dashboards
// (sidebar counter, executions page) stop polling GET /api/runs/active.
//
//   - Auth: a ticket scoped exactly `runs` (RunsTicketScope; a `run:<id>`
//     ticket is rejected and a `runs` ticket never opens a per-run socket) or
//     the k6flow.bearer subprotocol, identical to the per-run endpoint. The
//     origin policy is the shared CheckOrigin.
//   - On connect the subscriber receives one runs.snapshot (non-terminal runs
//     split active/queued, same items as GET /api/runs/active). Registration
//     and snapshot enqueue happen under the feed lock, so every event
//     published after the snapshot was taken is delivered after it.
//   - Events: runs.state on every transition (creation has fromState ""),
//     runs.end on terminal. Producers call PublishRunState/PublishRunEnd;
//     both encode once and fan out with non-blocking sends.
//   - Backpressure: unlike per-run metrics (drop-oldest, gaps allowed), a
//     lifecycle feed cannot silently lose events, so a subscriber whose
//     64-message buffer is full is CLOSED with 1013 (try again later); the
//     client reconnects and resyncs from a fresh snapshot. The close runs on
//     its own goroutine: publishing never blocks or performs socket I/O.
//   - Capacity: at most Deps.MaxRunsSubscribers (default 256) concurrent
//     subscribers; extras are upgraded and immediately closed with 1008.

import (
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"k6flow/apps/orchestrator/internal/runs"
)

// RunsTicketScope is the ticket scope that authorizes the global /ws/runs feed.
const RunsTicketScope = "runs"

const (
	// defaultMaxRunsSubscribers caps concurrent global-feed subscribers.
	defaultMaxRunsSubscribers = 256
	closePolicyViolation      = websocket.ClosePolicyViolation // 1008: over capacity
	closeTryAgainLater        = websocket.CloseTryAgainLater   // 1013: too slow, resync
)

// RunLister lists every known run (satisfied by *runs.Store).
type RunLister interface {
	List() []runs.Run
}

// runsFeed is the thread-safe registry of global-feed subscribers.
type runsFeed struct {
	mu   sync.Mutex
	subs map[*feedSubscriber]struct{}
	max  int
}

func newRunsFeed(max int) *runsFeed {
	if max <= 0 {
		max = defaultMaxRunsSubscribers
	}
	return &runsFeed{subs: make(map[*feedSubscriber]struct{}), max: max}
}

// feedSubscriber is one global-feed connection (conn may be nil in tests).
type feedSubscriber struct {
	feed      *runsFeed
	conn      *websocket.Conn
	ch        chan []byte
	done      chan struct{}
	closeOnce sync.Once
}

func newFeedSubscriber(feed *runsFeed, conn *websocket.Conn) *feedSubscriber {
	return &feedSubscriber{
		feed: feed,
		conn: conn,
		ch:   make(chan []byte, subscriberBuffer),
		done: make(chan struct{}),
	}
}

// close is the single teardown: unregister, optionally send the close frame
// (empty reason), signal the writer and bound the reader.
func (s *feedSubscriber) close(code int) {
	s.closeOnce.Do(func() {
		s.feed.remove(s)
		if s.conn != nil && code >= 0 {
			_ = s.conn.WriteControl(websocket.CloseMessage,
				websocket.FormatCloseMessage(code, ""), time.Now().Add(writeWait))
			_ = s.conn.SetReadDeadline(time.Now().Add(writeWait))
		}
		close(s.done)
	})
}

func (f *runsFeed) add(sub *feedSubscriber) bool { return f.addWith(sub, nil) }

// addWith registers sub unless the feed is full; initial (when non-nil) is
// evaluated and enqueued under the lock so it precedes every later event.
func (f *runsFeed) addWith(sub *feedSubscriber, initial func() []byte) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.subs) >= f.max {
		return false
	}
	if initial != nil {
		if data := initial(); data != nil {
			sub.ch <- data // fresh buffer: never blocks
		}
	}
	f.subs[sub] = struct{}{}
	return true
}

func (f *runsFeed) remove(sub *feedSubscriber) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.subs, sub)
}

func (f *runsFeed) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.subs)
}

func (f *runsFeed) detachAll() []*feedSubscriber {
	f.mu.Lock()
	defer f.mu.Unlock()
	subs := make([]*feedSubscriber, 0, len(f.subs))
	for sub := range f.subs {
		subs = append(subs, sub)
		delete(f.subs, sub)
	}
	return subs
}

// publish fans data out without blocking; full subscribers are unregistered
// here and closed asynchronously with 1013.
func (f *runsFeed) publish(data []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for sub := range f.subs {
		select {
		case sub.ch <- data:
		default:
			delete(f.subs, sub)
			go sub.close(closeTryAgainLater)
		}
	}
}

// PublishRunState pushes a runs.state event to every global-feed subscriber
// (from is empty for the creation event). Never blocks.
func (s *Server) PublishRunState(run runs.Run, from, to runs.Status, at time.Time) {
	data, err := EncodeMessage(NewRunsStateMessage(run, from, to, at))
	if err != nil {
		s.logger.Warn("runs.state encode failed", "runId", run.ID, "err", err)
		return
	}
	s.feed.publish(data)
}

// PublishRunEnd pushes a runs.end event to every global-feed subscriber.
// Never blocks.
func (s *Server) PublishRunEnd(run runs.Run) {
	data, err := EncodeMessage(NewRunsEndMessage(run))
	if err != nil {
		s.logger.Warn("runs.end encode failed", "runId", run.ID, "err", err)
		return
	}
	s.feed.publish(data)
}

// snapshot encodes the current runs.snapshot (empty lists without a lister).
func (s *Server) snapshot() []byte {
	var all []runs.Run
	if s.lister != nil {
		all = s.lister.List()
	}
	data, err := EncodeMessage(NewRunsSnapshotMessage(all))
	if err != nil {
		s.logger.Warn("runs.snapshot encode failed", "err", err)
		return nil
	}
	return data
}

// handleRunsFeed runs the global-feed handshake: 401 auth (scope `runs`),
// origin check inside the upgrade, capacity gate, then snapshot + events.
func (s *Server) handleRunsFeed(w http.ResponseWriter, r *http.Request) {
	if !s.authorizedScope(r, RunsTicketScope) {
		s.logger.Warn("runs feed handshake rejected", "reason", "auth", "remote", r.RemoteAddr)
		s.writeError(w, http.StatusUnauthorized, codeUnauthorized, msgUnauthorized)
		return
	}
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.logger.Warn("runs feed upgrade failed", "err", err)
		return
	}
	sub := newFeedSubscriber(s.feed, conn)
	if !s.feed.addWith(sub, s.snapshot) {
		s.logger.Warn("runs feed at capacity; closing extra subscriber", "max", s.feed.max)
		_ = conn.WriteControl(websocket.CloseMessage,
			websocket.FormatCloseMessage(closePolicyViolation, ""), time.Now().Add(writeWait))
		_ = conn.Close()
		return
	}
	s.logger.Info("runs feed subscriber connected")
	defer func() {
		sub.close(closeNoFrame)
		_ = conn.Close()
	}()
	go s.feedWritePump(sub)
	s.feedReadPump(sub)
}

// feedWritePump is the connection's single writer (see writePump).
func (s *Server) feedWritePump(sub *feedSubscriber) {
	for {
		select {
		case <-sub.done:
			return
		case data := <-sub.ch:
			_ = sub.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := sub.conn.WriteMessage(websocket.TextMessage, data); err != nil {
				s.logger.Warn("runs feed write failed; dropping subscriber", "err", err)
				sub.close(closeInternalError)
				return
			}
		}
	}
}

// feedReadPump drains the receive-only client until it goes away.
func (s *Server) feedReadPump(sub *feedSubscriber) {
	sub.conn.SetReadLimit(readLimit)
	for {
		if _, _, err := sub.conn.ReadMessage(); err != nil {
			s.logger.Info("runs feed subscriber disconnected", "err", err)
			return
		}
	}
}
