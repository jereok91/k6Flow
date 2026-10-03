// Package wsapi provides WebSocket handlers for real-time recording events.
package wsapi

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync"

	"github.com/gorilla/websocket"

	"k6flow/apps/recorder/internal/store"
)

const apiVersion = 1

var upgrader = websocket.Upgrader{
	CheckOrigin: func(_ *http.Request) bool { return true },
}

// Hub manages WebSocket connections per recording.
type Hub struct {
	mu      sync.RWMutex
	clients map[string]map[*websocket.Conn]bool
}

// NewHub creates a new WebSocket hub.
func NewHub() *Hub {
	return &Hub{
		clients: make(map[string]map[*websocket.Conn]bool),
	}
}

// Server handles WebSocket connections.
type Server struct {
	hub       *Hub
	store     *store.Store
	authToken string
}

// NewServer creates a new WebSocket server.
func NewServer(hub *Hub, st *store.Store, authToken string) *Server {
	return &Server{hub: hub, store: st, authToken: authToken}
}

// --- Message types ---

type initFrame struct {
	Version int    `json:"version"`
	Type    string `json:"type"`
}

type captureFrame struct {
	Version int                `json:"version"`
	Type    string             `json:"type"`
	Entry   store.CaptureEntry `json:"entry"`
}

type statusFrame struct {
	Version int    `json:"version"`
	Type    string `json:"type"`
	Status  string `json:"status"`
}

type errorFrame struct {
	Version int    `json:"version"`
	Type    string `json:"type"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

// HandleWebSocket upgrades the connection and streams events.
// Path: /ws/recordings/{recordingId}
func (s *Server) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	// Check auth
	if s.authToken != "" {
		auth := r.Header.Get("Authorization")
		if !strings.HasPrefix(auth, "Bearer ") || strings.TrimPrefix(auth, "Bearer ") != s.authToken {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
	}

	// Extract recording ID
	id := extractRecordingID(r.URL.Path)
	if id == "" {
		http.Error(w, "missing recording id", http.StatusBadRequest)
		return
	}

	// Check recording exists
	rec := s.store.Get(id)
	if rec == nil {
		http.Error(w, "recording not found", http.StatusNotFound)
		return
	}

	// Upgrade connection
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ws upgrade error: %v", err)
		return
	}
	defer conn.Close()

	// Register client
	s.hub.register(id, conn)
	defer s.hub.unregister(id, conn)

	// Wait for init frame
	var init initFrame
	if err := conn.ReadJSON(&init); err != nil {
		s.sendError(conn, "invalid-frame", "Expected init frame")
		return
	}
	if init.Version != apiVersion || init.Type != "init" {
		s.sendError(conn, "invalid-frame", "Expected version 1 init frame")
		return
	}

	// Send current status
	rec = s.store.Get(id)
	if rec != nil {
		s.sendStatus(conn, string(rec.Status))
	}

	// Keep connection alive until closed
	for {
		_, _, err := conn.ReadMessage()
		if err != nil {
			break
		}
	}
}

// BroadcastCapture sends a capture event to all clients watching a recording.
func (s *Server) BroadcastCapture(recordingID string, entry store.CaptureEntry) {
	frame := captureFrame{
		Version: apiVersion,
		Type:    "capture",
		Entry:   entry,
	}

	s.hub.broadcast(recordingID, frame)
}

// BroadcastStatus sends a status change to all clients watching a recording.
func (s *Server) BroadcastStatus(recordingID string, status string) {
	frame := statusFrame{
		Version: apiVersion,
		Type:    "status",
		Status:  status,
	}

	s.hub.broadcast(recordingID, frame)
}

func (s *Server) sendError(conn *websocket.Conn, code, message string) {
	frame := errorFrame{
		Version: apiVersion,
		Type:    "error",
		Code:    code,
		Message: message,
	}
	_ = conn.WriteJSON(frame)
}

func (s *Server) sendStatus(conn *websocket.Conn, status string) {
	frame := statusFrame{
		Version: apiVersion,
		Type:    "status",
		Status:  status,
	}
	_ = conn.WriteJSON(frame)
}

func (h *Hub) register(recordingID string, conn *websocket.Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if h.clients[recordingID] == nil {
		h.clients[recordingID] = make(map[*websocket.Conn]bool)
	}
	h.clients[recordingID][conn] = true
}

func (h *Hub) unregister(recordingID string, conn *websocket.Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if conns, ok := h.clients[recordingID]; ok {
		delete(conns, conn)
		if len(conns) == 0 {
			delete(h.clients, recordingID)
		}
	}
}

func (h *Hub) broadcast(recordingID string, msg any) {
	h.mu.RLock()
	conns := h.clients[recordingID]
	h.mu.RUnlock()

	data, err := json.Marshal(msg)
	if err != nil {
		return
	}

	for conn := range conns {
		if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
			conn.Close()
		}
	}
}

func extractRecordingID(path string) string {
	// Path format: /ws/recordings/{id}
	const prefix = "/ws/recordings/"
	if !strings.HasPrefix(path, prefix) {
		return ""
	}
	return strings.TrimPrefix(path, prefix)
}
