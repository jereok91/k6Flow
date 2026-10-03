package wsapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"k6flow/apps/recorder/internal/store"
)

func TestExtractRecordingID(t *testing.T) {
	tests := []struct {
		path string
		want string
	}{
		{"/ws/recordings/abc123", "abc123"},
		{"/ws/recordings/", ""},
		{"/other/path", ""},
	}

	for _, tc := range tests {
		got := extractRecordingID(tc.path)
		if got != tc.want {
			t.Errorf("extractRecordingID(%q) = %q, want %q", tc.path, got, tc.want)
		}
	}
}

func TestHubRegisterUnregister(t *testing.T) {
	hub := NewHub()

	// Mock connection (we just need a pointer for the map)
	conn := &websocket.Conn{}

	hub.register("rec1", conn)

	hub.mu.RLock()
	if _, ok := hub.clients["rec1"][conn]; !ok {
		t.Error("connection not registered")
	}
	hub.mu.RUnlock()

	hub.unregister("rec1", conn)

	hub.mu.RLock()
	if _, ok := hub.clients["rec1"]; ok {
		t.Error("recording should be removed when empty")
	}
	hub.mu.RUnlock()
}

func TestWebSocketConnection(t *testing.T) {
	st := store.New()
	hub := NewHub()
	srv := NewServer(hub, st, "")

	// Create a recording
	id := st.Create()

	// Create test server
	mux := http.NewServeMux()
	mux.HandleFunc("/ws/recordings/", srv.HandleWebSocket)
	server := httptest.NewServer(mux)
	defer server.Close()

	// Connect via WebSocket
	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws/recordings/" + id
	conn, resp, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial error: %v", err)
	}
	defer conn.Close()

	if resp.StatusCode != http.StatusSwitchingProtocols {
		t.Errorf("status = %d, want 101", resp.StatusCode)
	}

	// Send init frame
	init := initFrame{Version: 1, Type: "init"}
	if err := conn.WriteJSON(init); err != nil {
		t.Fatalf("write init: %v", err)
	}

	// Should receive status
	var status statusFrame
	conn.SetReadDeadline(time.Now().Add(time.Second))
	if err := conn.ReadJSON(&status); err != nil {
		t.Fatalf("read status: %v", err)
	}

	if status.Type != "status" {
		t.Errorf("type = %q, want status", status.Type)
	}
	if status.Status != "pending" {
		t.Errorf("status = %q, want pending", status.Status)
	}
}

func TestWebSocketNotFound(t *testing.T) {
	st := store.New()
	hub := NewHub()
	srv := NewServer(hub, st, "")

	mux := http.NewServeMux()
	mux.HandleFunc("/ws/recordings/", srv.HandleWebSocket)
	server := httptest.NewServer(mux)
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws/recordings/nonexistent"
	_, resp, err := websocket.DefaultDialer.Dial(wsURL, nil)

	if err == nil {
		t.Error("expected error for nonexistent recording")
	}
	if resp != nil && resp.StatusCode != http.StatusNotFound {
		t.Errorf("status = %d, want 404", resp.StatusCode)
	}
}

func TestWebSocketAuth(t *testing.T) {
	st := store.New()
	hub := NewHub()
	srv := NewServer(hub, st, "secret-token")

	id := st.Create()

	mux := http.NewServeMux()
	mux.HandleFunc("/ws/recordings/", srv.HandleWebSocket)
	server := httptest.NewServer(mux)
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws/recordings/" + id

	// Without auth
	_, resp, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err == nil {
		t.Error("expected error without auth")
	}
	if resp != nil && resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", resp.StatusCode)
	}

	// With auth
	headers := http.Header{}
	headers.Set("Authorization", "Bearer secret-token")
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, headers)
	if err != nil {
		t.Fatalf("dial with auth: %v", err)
	}
	conn.Close()
}

func TestBroadcastCapture(t *testing.T) {
	st := store.New()
	hub := NewHub()
	srv := NewServer(hub, st, "")

	id := st.Create()

	mux := http.NewServeMux()
	mux.HandleFunc("/ws/recordings/", srv.HandleWebSocket)
	server := httptest.NewServer(mux)
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws/recordings/" + id
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	// Send init
	conn.WriteJSON(initFrame{Version: 1, Type: "init"})

	// Read initial status
	var status statusFrame
	conn.SetReadDeadline(time.Now().Add(time.Second))
	conn.ReadJSON(&status)

	// Broadcast a capture
	entry := store.CaptureEntry{
		Method:   "GET",
		URL:      "https://example.com",
		Status:   200,
		Headers:  []store.HeaderEntry{},
		Redacted: false,
	}
	srv.BroadcastCapture(id, entry)

	// Read capture
	var capture captureFrame
	conn.SetReadDeadline(time.Now().Add(time.Second))
	if err := conn.ReadJSON(&capture); err != nil {
		t.Fatalf("read capture: %v", err)
	}

	if capture.Type != "capture" {
		t.Errorf("type = %q, want capture", capture.Type)
	}
	if capture.Entry.Method != "GET" {
		t.Errorf("method = %q, want GET", capture.Entry.Method)
	}
}

func TestBroadcastStatus(t *testing.T) {
	st := store.New()
	hub := NewHub()
	srv := NewServer(hub, st, "")

	id := st.Create()

	mux := http.NewServeMux()
	mux.HandleFunc("/ws/recordings/", srv.HandleWebSocket)
	server := httptest.NewServer(mux)
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws/recordings/" + id
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	// Send init
	conn.WriteJSON(initFrame{Version: 1, Type: "init"})

	// Read initial status
	var initial statusFrame
	conn.SetReadDeadline(time.Now().Add(time.Second))
	conn.ReadJSON(&initial)

	// Broadcast status change
	srv.BroadcastStatus(id, "recording")

	// Read new status
	var status statusFrame
	conn.SetReadDeadline(time.Now().Add(time.Second))
	if err := conn.ReadJSON(&status); err != nil {
		t.Fatalf("read status: %v", err)
	}

	if status.Status != "recording" {
		t.Errorf("status = %q, want recording", status.Status)
	}
}
