// Package live implements the Phase 3 metrics WebSocket endpoint (K6F3-02):
// `GET /ws/runs/{runId}` over github.com/gorilla/websocket, backed by a
// per-run subscriber hub that implements metrics.FrameSink. The full decision
// record (gorilla pin, auth scheme, origin policy, backpressure and close
// semantics) lives in docs/DECISIONES.md, K6F3-02. Documented policies:
//
//   - Handshake auth: browsers present a short-lived signed ticket as
//     `?ticket=` (see ticket.go; scope `run:<runId>` must match the path,
//     minted by the web app after session + ownership checks). Non-browser /
//     server-side clients keep approved Phase 3 policy 2: they offer the
//     subprotocols ["k6flow.bearer", "<token>"]; the token is compared in
//     constant time against config's ServiceToken (fail-closed when the
//     configured token is empty) and the scheme must be present. The raw
//     service token is NOT accepted as a query parameter. Missing,
//     wrong-scheme, wrong-token or fail-closed handshakes get HTTP 401 before
//     the upgrade, with no Sec-WebSocket-* headers. Authentication runs
//     before the run-existence lookup so unauthenticated clients cannot
//     probe which runs exist. On success the server negotiates and echoes the
//     single subprotocol `k6flow.bearer`.
//   - Origin (same-origin default, explicit allowlist override): the default
//     CheckOrigin compares the Origin host with the request Host (scheme is
//     ignored, so a TLS-terminating proxy still matches). An explicit
//     Deps.AllowedOrigins list replaces the default — it exists because the
//     K6F3-04 Next proxy makes the browser Origin the web origin, which
//     differs from the orchestrator Host. A missing Origin is allowed: only
//     non-browser clients omit it, and browsers always send it on a WS
//     handshake. Rejected origins fail the upgrade with HTTP 403 (gorilla).
//   - Backpressure (approved Phase 3 policy 3): each subscriber owns a
//     64-frame buffered channel. OnFrame encodes the frame once and fans out
//     with a non-blocking send; when a subscriber's buffer is full the oldest
//     queued frame is drained first (drop-oldest), so the newest frame always
//     lands and `seq` stays monotonic with allowed gaps. OnFrame NEVER blocks:
//     the engine tap (R3-blocking-sink-stalls-completion advisory) must not be
//     stalled by a slow dashboard client.
//   - Single writer: one goroutine per connection drains the channel and
//     writes TextMessage frames (gorilla permits one concurrent writer);
//     frame messages can therefore never interleave. Write failures drop the
//     connection with close code 1011 (empty reason), best effort.
//   - Close semantics: CloseRun(runID, code) unregisters every subscriber of
//     the run (registry entry pruned) and sends the close frame with an EMPTY
//     reason — the terminal state frame is a deferred capability, so close
//     1000 carries no payload beyond the code. CloseAll(code) does the same
//     for every run (server shutdown, K6F3-03).
//   - Read side: the client is receive-only. Inbound application messages are
//     discarded (1 KiB read limit); ping/pong and the close handshake are
//     handled by gorilla's default handlers; a client-initiated close or any
//     read error unregisters the subscriber and shuts the connection down.
package live

import (
	"crypto/subtle"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"k6flow/apps/orchestrator/internal/metrics"
	"k6flow/apps/orchestrator/internal/runs"
)

const (
	// subprotocol is the negotiated auth subprotocol: the client offers
	// ["k6flow.bearer", "<token>"] and the server echoes k6flow.bearer only.
	subprotocol = "k6flow.bearer"
	// subscriberBuffer is the approved per-subscriber frame buffer (policy 3).
	subscriberBuffer = 64
	// writeWait bounds frame writes and close-frame delivery; a write that
	// exceeds it fails the connection instead of stalling the writer forever.
	writeWait = 10 * time.Second
	// readLimit bounds inbound client messages (the client is receive-only).
	readLimit = 1024
	// closeNoFrame tears a subscriber down without sending a close frame
	// (peer-initiated close or local cleanup); codes >= 0 are sent as
	// (code, empty reason).
	closeNoFrame = -1
)

// Close codes used by this package (RFC 6455 / gorilla constants):
// CloseRun/CloseAll callers pass 1000 (empty reason, no terminal frame);
// closeInternalError drops a connection whose frame writes failed.
const (
	closeNormal        = websocket.CloseNormalClosure     // 1000
	closeInternalError = websocket.CloseInternalServerErr // 1011
)

// Envelope codes/messages mirror the contract-04 error catalog style used by
// internal/httpapi (frozen) so handshake rejections stay uniform.
const (
	contractVersion = 1

	codeUnauthorized = "unauthorized"
	codeRunNotFound  = "run-not-found"

	msgUnauthorized = "missing or invalid ticket or Sec-WebSocket-Protocol bearer token"
	msgRunNotFound  = "unknown runId"
)

// RunLookup is the run-existence dependency, defined here so the live package
// never depends on a concrete store: *runs.Store satisfies it and tests
// substitute a fake (same pattern as httpapi.RunLauncher).
type RunLookup interface {
	Get(id string) (runs.Run, bool)
}

// Deps are the constructor dependencies. Token is config's ServiceToken
// (empty fails closed), Lookup checks run existence before the upgrade and
// Logger defaults to slog.Default. AllowedOrigins optionally replaces the
// default same-origin CheckOrigin policy (see package doc).
type Deps struct {
	Token          string
	Lookup         RunLookup
	Logger         *slog.Logger
	AllowedOrigins []string
	// Runs feeds the global /ws/runs snapshot (nil ⇒ empty snapshot).
	Runs RunLister
	// MaxRunsSubscribers caps /ws/runs subscribers (<= 0 ⇒ 256).
	MaxRunsSubscribers int
}

// Server hosts the metrics WebSocket endpoint and the per-run hub. It
// implements metrics.FrameSink: the engine tap (K6F3-03) will call OnFrame.
type Server struct {
	token          string
	lookup         RunLookup
	logger         *slog.Logger
	allowedOrigins []string
	upgrader       websocket.Upgrader
	hub            *hub
	lister         RunLister
	feed           *runsFeed
}

var (
	_ metrics.FrameSink = (*Server)(nil)
	_ metrics.FrameSink = (*hub)(nil)
)

// New builds the WS server. The returned value is safe for concurrent use.
func New(deps Deps) *Server {
	logger := deps.Logger
	if logger == nil {
		logger = slog.Default()
	}
	s := &Server{
		token:          deps.Token,
		lookup:         deps.Lookup,
		logger:         logger,
		allowedOrigins: append([]string(nil), deps.AllowedOrigins...),
		hub:            newHub(logger),
		lister:         deps.Runs,
		feed:           newRunsFeed(deps.MaxRunsSubscribers),
	}
	s.upgrader = websocket.Upgrader{
		Subprotocols:     []string{subprotocol},
		HandshakeTimeout: writeWait,
		CheckOrigin:      s.checkOrigin,
	}
	return s
}

// Handler mounts `GET /ws/runs/{runId}` on a ServeMux (Go 1.22 pattern): a
// blank or nested runId falls through to the mux 404, non-GET methods get 405,
// and both rejections happen before any upgrade. The exact path `GET /ws/runs`
// serves the global runs feed (runs_feed.go).
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /ws/runs/{runId}", s.handleUpgrade)
	mux.HandleFunc("GET /ws/runs", s.handleRunsFeed)
	return mux
}

// OnFrame implements metrics.FrameSink (encode once, non-blocking fan-out).
func (s *Server) OnFrame(frame metrics.MetricsFrame) {
	s.hub.OnFrame(frame)
}

// BroadcastState sends a state change message to all subscribers of a run.
func (s *Server) BroadcastState(runID string, from, to runs.Status, at time.Time, actor, cause string) {
	msg := NewStateMessage(runID, from, to, at, actor, cause)
	data, err := EncodeMessage(msg)
	if err != nil {
		s.logger.Warn("state message encode failed", "runId", runID, "err", err)
		return
	}
	s.hub.broadcast(runID, data)
}

// BroadcastEnd sends an end message to all subscribers of a run.
func (s *Server) BroadcastEnd(run runs.Run) {
	msg := NewEndMessage(run)
	data, err := EncodeMessage(msg)
	if err != nil {
		s.logger.Warn("end message encode failed", "runId", run.ID, "err", err)
		return
	}
	s.hub.broadcast(run.ID, data)
}

// CloseRun sends the close frame (given code, empty reason, no terminal
// frame) to every subscriber of runID and prunes the registry entry. Safe to
// call when the run has no subscribers; concurrent with broadcasts.
func (s *Server) CloseRun(runID string, code int) {
	subs := s.hub.detach(runID)
	for _, sub := range subs {
		sub.closeWithCode(code)
	}
	s.logger.Info("closed run subscribers", "runId", runID, "count", len(subs), "code", code)
}

// CloseAll closes every subscriber of every run (server shutdown, K6F3-03),
// including the global runs feed subscribers.
func (s *Server) CloseAll(code int) {
	subs := s.hub.detachAll()
	for _, sub := range subs {
		sub.closeWithCode(code)
	}
	for _, sub := range s.feed.detachAll() {
		sub.close(code)
	}
	s.logger.Info("closed all websocket subscribers", "count", len(subs), "code", code)
}

// handleUpgrade runs the documented handshake gate: blank runId (defensive),
// 401 auth, 404 unknown run, then the gorilla upgrade; afterwards it owns the
// connection until the client goes away.
func (s *Server) handleUpgrade(w http.ResponseWriter, r *http.Request) {
	runID := r.PathValue("runId")
	if runID == "" {
		s.writeError(w, http.StatusNotFound, codeRunNotFound, msgRunNotFound)
		return
	}
	// Auth precedes the lookup: an unauthenticated client learns nothing
	// about which runs exist.
	if !s.authorized(r, runID) {
		s.logger.Warn("websocket handshake rejected", "reason", "auth", "runId", runID, "remote", r.RemoteAddr)
		s.writeError(w, http.StatusUnauthorized, codeUnauthorized, msgUnauthorized)
		return
	}
	if s.lookup == nil {
		s.writeError(w, http.StatusNotFound, codeRunNotFound, msgRunNotFound)
		return
	}
	run, ok := s.lookup.Get(runID)
	if !ok {
		s.logger.Warn("websocket handshake rejected", "reason", "unknown-run", "runId", runID, "remote", r.RemoteAddr)
		s.writeError(w, http.StatusNotFound, codeRunNotFound, msgRunNotFound)
		return
	}
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		// gorilla already answered (400/403/405 …); e.g. a rejected Origin.
		s.logger.Warn("websocket upgrade failed", "runId", runID, "err", err)
		return
	}
	lastSeq := s.hub.GetLastSeq(runID)
	sub := &subscriber{
		runID:   runID,
		hub:     s.hub,
		conn:    conn,
		ch:      make(chan []byte, subscriberBuffer),
		done:    make(chan struct{}),
		lastSeq: lastSeq,
	}
	s.hub.add(sub)
	s.logger.Info("websocket subscriber connected", "runId", runID)

	// Send hello message
	hello := NewHelloMessage(run, lastSeq)
	if data, err := EncodeMessage(hello); err == nil {
		_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
		_ = conn.WriteMessage(websocket.TextMessage, data)
	}
	defer func() {
		sub.closeWithCode(closeNoFrame)
		_ = conn.Close()
	}()
	go s.writePump(sub)
	s.readPump(sub)
}

// authorized gates the handshake. Browser clients present `?ticket=` (a
// short-lived HMAC ticket scoped to run:<runId>, see ticket.go); when a
// ticket is present it is the only credential considered. Otherwise the
// Sec-WebSocket-Protocol offer must carry the scheme k6flow.bearer plus a
// value matching the configured token (constant time); extra offered values
// are ignored. The raw service token is never accepted in the query string.
// An empty configured token fails closed on both paths.
func (s *Server) authorized(r *http.Request, runID string) bool {
	return s.authorizedScope(r, RunTicketScope(runID))
}

// authorizedScope is authorized with an explicit ticket scope (`run:<id>`
// for the per-run endpoint, `runs` for the global feed).
func (s *Server) authorizedScope(r *http.Request, scope string) bool {
	if s.token == "" {
		return false
	}
	if ticket := r.URL.Query().Get("ticket"); ticket != "" {
		return VerifyTicket(ticket, s.token, scope, time.Now()) == nil
	}
	// Server-side / non-browser clients: subprotocol bearer auth.
	hasScheme := false
	tokenOK := false
	for _, line := range r.Header.Values("Sec-WebSocket-Protocol") {
		for _, value := range strings.Split(line, ",") {
			value = strings.TrimSpace(value)
			switch {
			case value == subprotocol:
				hasScheme = true
			case subtle.ConstantTimeCompare([]byte(value), []byte(s.token)) == 1:
				tokenOK = true
			}
		}
	}
	return hasScheme && tokenOK
}

// checkOrigin implements the documented origin policy: missing Origin is a
// non-browser client (allowed), an explicit allowlist replaces the default,
// otherwise the Origin host must equal the request Host (same-origin).
func (s *Server) checkOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	if len(s.allowedOrigins) > 0 {
		for _, allowed := range s.allowedOrigins {
			if strings.EqualFold(allowed, origin) {
				return true
			}
		}
		return false
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return strings.EqualFold(u.Host, r.Host)
}

// errorBody is the flat contract error envelope (same shape as internal/httpapi).
type errorBody struct {
	Version int    `json:"version"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (s *Server) writeError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(errorBody{Version: contractVersion, Code: code, Message: message})
}

// subscriber is one connected client. ch holds encoded frames (drop-oldest,
// cap subscriberBuffer); done signals the writer goroutine to exit; closeOnce
// makes teardown single-shot regardless of which path gets there first.
type subscriber struct {
	runID     string
	hub       *hub
	conn      *websocket.Conn
	ch        chan []byte
	done      chan struct{}
	closeOnce sync.Once
	lastSeq   int64 // for reconnection support
}

// offer is the non-blocking drop-oldest enqueue (R3 advisory: OnFrame must
// never block): try to send; if the buffer is full, drain the oldest frame
// and retry once — the newest frame always lands, seq keeps allowed gaps.
func (s *subscriber) offer(data []byte) {
	select {
	case s.ch <- data:
		return
	default:
	}
	select {
	case <-s.ch: // drop oldest
	default:
	}
	select {
	case s.ch <- data:
	default: // a concurrent drainer re-filled the slot; drop this frame
	}
}

// closeWithCode performs the single teardown: unregister (pruning the run's
// registry entry), optionally send the close frame with an EMPTY reason,
// signal the writer, and bound the reader so a peer that never echoes the
// close cannot leak the pump. Subsequent calls are no-ops.
func (s *subscriber) closeWithCode(code int) {
	s.closeOnce.Do(func() {
		s.hub.remove(s)
		if code >= 0 {
			// WriteControl is gorilla's concurrency-safe writer (safe next
			// to the frame writer goroutine) and its deadline bounds the wait.
			_ = s.conn.WriteControl(
				websocket.CloseMessage,
				websocket.FormatCloseMessage(code, ""),
				time.Now().Add(writeWait),
			)
			_ = s.conn.SetReadDeadline(time.Now().Add(writeWait))
		}
		close(s.done)
	})
}

// hub is the thread-safe per-run subscriber registry and the broadcast path.
type hub struct {
	mu       sync.Mutex
	runs     map[string]map[*subscriber]struct{}
	lastSeqs map[string]int64 // last sequence per run
	logger   *slog.Logger
}

func newHub(logger *slog.Logger) *hub {
	return &hub{
		runs:     make(map[string]map[*subscriber]struct{}),
		lastSeqs: make(map[string]int64),
		logger:   logger,
	}
}

func (h *hub) add(sub *subscriber) {
	h.mu.Lock()
	defer h.mu.Unlock()
	set := h.runs[sub.runID]
	if set == nil {
		set = make(map[*subscriber]struct{})
		h.runs[sub.runID] = set
	}
	set[sub] = struct{}{}
}

func (h *hub) remove(sub *subscriber) {
	h.mu.Lock()
	defer h.mu.Unlock()
	set := h.runs[sub.runID]
	delete(set, sub)
	if len(set) == 0 {
		delete(h.runs, sub.runID)
	}
}

// detach removes runID's whole subscriber set from the registry and returns
// it (the run key is pruned even when empty).
func (h *hub) detach(runID string) []*subscriber {
	h.mu.Lock()
	defer h.mu.Unlock()
	subs := flatten(h.runs[runID])
	delete(h.runs, runID)
	return subs
}

// detachAll removes every subscriber of every run (registry emptied).
func (h *hub) detachAll() []*subscriber {
	h.mu.Lock()
	defer h.mu.Unlock()
	var subs []*subscriber
	for runID, set := range h.runs {
		subs = append(subs, flatten(set)...)
		delete(h.runs, runID)
	}
	return subs
}

func flatten(set map[*subscriber]struct{}) []*subscriber {
	if len(set) == 0 {
		return nil
	}
	subs := make([]*subscriber, 0, len(set))
	for sub := range set {
		subs = append(subs, sub)
	}
	return subs
}

// OnFrame implements metrics.FrameSink: the frame is encoded exactly once and
// fanned out with non-blocking sends. It never blocks and never performs
// socket I/O, so a stalled subscriber cannot stall the engine tap that calls
// it (R3-blocking-sink-stalls-completion). The hub lock is held only across
// channel operations.
func (h *hub) OnFrame(frame metrics.MetricsFrame) {
	// Wrap in tick message for unified envelope
	tick := NewTickMessage(frame)
	data, err := EncodeMessage(tick)
	if err != nil {
		h.logger.Warn("metrics frame encode failed; dropped", "runId", frame.RunID, "seq", frame.Seq, "err", err)
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.lastSeqs[frame.RunID] = frame.Seq
	for sub := range h.runs[frame.RunID] {
		sub.offer(data)
	}
}

// GetLastSeq returns the last sequence number for a run.
func (h *hub) GetLastSeq(runID string) int64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.lastSeqs[runID]
}

// broadcast sends encoded data to all subscribers of a run.
func (h *hub) broadcast(runID string, data []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for sub := range h.runs[runID] {
		sub.offer(data)
	}
}

// writePump is the connection's single writer: it drains the buffered channel
// and writes TextMessage frames. After a close frame is sent gorilla fails
// every subsequent write with ErrCloseSent, so no data frame can follow a
// close. A write failure drops the connection with close 1011 (empty reason).
func (s *Server) writePump(sub *subscriber) {
	for {
		select {
		case <-sub.done:
			return
		case data := <-sub.ch:
			_ = sub.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := sub.conn.WriteMessage(websocket.TextMessage, data); err != nil {
				s.logger.Warn("websocket write failed; dropping subscriber",
					"runId", sub.runID, "err", err)
				sub.closeWithCode(closeInternalError)
				return
			}
		}
	}
}

// readPump drains the receive-only client: application messages are discarded
// (1 KiB limit) while gorilla's default handlers answer ping and complete the
// close handshake. Any read error means the client is gone and tears the
// subscriber down (the caller's defer closes the socket).
func (s *Server) readPump(sub *subscriber) {
	sub.conn.SetReadLimit(readLimit)
	for {
		if _, _, err := sub.conn.ReadMessage(); err != nil {
			s.logger.Info("websocket subscriber disconnected", "runId", sub.runID, "err", err)
			return
		}
		// Client data messages are discarded by policy (receive-only client).
	}
}
