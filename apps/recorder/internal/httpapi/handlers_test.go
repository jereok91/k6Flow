package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"k6flow/apps/recorder/internal/store"
)

func TestHandleHealthz(t *testing.T) {
	s := NewServer(store.New(), "")
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()

	s.HandleHealthz(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}

	var body healthResponse
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body.Status != "ok" {
		t.Errorf("status = %q, want ok", body.Status)
	}
}

func TestHandleCreateRecording(t *testing.T) {
	s := NewServer(store.New(), "")
	body := `{"version":1}`
	req := httptest.NewRequest(http.MethodPost, "/api/recorder/recordings", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	s.HandleCreateRecording(rec, req)

	if rec.Code != http.StatusCreated {
		t.Errorf("status = %d, want 201", rec.Code)
	}

	var resp createResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Version != 1 {
		t.Errorf("version = %d, want 1", resp.Version)
	}
	if resp.RecordingID == "" {
		t.Error("recordingId is empty")
	}
}

func TestHandleCreateRecordingInvalidVersion(t *testing.T) {
	s := NewServer(store.New(), "")
	body := `{"version":99}`
	req := httptest.NewRequest(http.MethodPost, "/api/recorder/recordings", bytes.NewBufferString(body))
	rec := httptest.NewRecorder()

	s.HandleCreateRecording(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestHandleCreateRecordingAuth(t *testing.T) {
	s := NewServer(store.New(), "secret-token")

	// Without auth
	req := httptest.NewRequest(http.MethodPost, "/api/recorder/recordings", bytes.NewBufferString(`{"version":1}`))
	rec := httptest.NewRecorder()
	s.HandleCreateRecording(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("without auth: status = %d, want 401", rec.Code)
	}

	// With wrong token
	req = httptest.NewRequest(http.MethodPost, "/api/recorder/recordings", bytes.NewBufferString(`{"version":1}`))
	req.Header.Set("Authorization", "Bearer wrong-token")
	rec = httptest.NewRecorder()
	s.HandleCreateRecording(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("wrong token: status = %d, want 401", rec.Code)
	}

	// With correct token
	req = httptest.NewRequest(http.MethodPost, "/api/recorder/recordings", bytes.NewBufferString(`{"version":1}`))
	req.Header.Set("Authorization", "Bearer secret-token")
	rec = httptest.NewRecorder()
	s.HandleCreateRecording(rec, req)
	if rec.Code != http.StatusCreated {
		t.Errorf("correct token: status = %d, want 201", rec.Code)
	}
}

func TestHandleGetRecording(t *testing.T) {
	st := store.New()
	s := NewServer(st, "")

	// Create a recording
	id := st.Create()

	req := httptest.NewRequest(http.MethodGet, "/api/recorder/recordings/"+id, nil)
	rec := httptest.NewRecorder()

	s.HandleGetRecording(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rec.Code)
	}

	var resp stateResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.RecordingID != id {
		t.Errorf("recordingId = %q, want %q", resp.RecordingID, id)
	}
	if resp.Status != "pending" {
		t.Errorf("status = %q, want pending", resp.Status)
	}
}

func TestHandleGetRecordingNotFound(t *testing.T) {
	s := NewServer(store.New(), "")

	req := httptest.NewRequest(http.MethodGet, "/api/recorder/recordings/nonexistent", nil)
	rec := httptest.NewRecorder()

	s.HandleGetRecording(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", rec.Code)
	}

	var resp errorResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Code != "recording-not-found" {
		t.Errorf("code = %q, want recording-not-found", resp.Code)
	}
}

func TestHandleStopRecording(t *testing.T) {
	st := store.New()
	s := NewServer(st, "")

	// Create and start recording
	id := st.Create()
	st.SetStatus(id, store.StatusRecording)
	st.AddCapture(id, store.CaptureEntry{
		Method:   "GET",
		URL:      "https://example.com",
		Status:   200,
		Headers:  []store.HeaderEntry{{Name: "Content-Type", Value: "text/html"}},
		Redacted: false,
	})

	req := httptest.NewRequest(http.MethodPost, "/api/recorder/recordings/"+id+"/stop", nil)
	rec := httptest.NewRecorder()

	s.HandleStopRecording(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rec.Code)
	}

	var resp stopResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Status != "completed" {
		t.Errorf("status = %q, want completed", resp.Status)
	}
	if len(resp.Capture) != 1 {
		t.Errorf("captures = %d, want 1", len(resp.Capture))
	}
}

func TestHandleStopRecordingIdempotent(t *testing.T) {
	st := store.New()
	s := NewServer(st, "")

	id := st.Create()
	st.SetStatus(id, store.StatusCompleted)

	// Stop already completed recording
	req := httptest.NewRequest(http.MethodPost, "/api/recorder/recordings/"+id+"/stop", nil)
	rec := httptest.NewRecorder()

	s.HandleStopRecording(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rec.Code)
	}

	var resp stopResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Status != "completed" {
		t.Errorf("status = %q, want completed", resp.Status)
	}
}

func TestHandleStopRecordingNotFound(t *testing.T) {
	s := NewServer(store.New(), "")

	req := httptest.NewRequest(http.MethodPost, "/api/recorder/recordings/nonexistent/stop", nil)
	rec := httptest.NewRecorder()

	s.HandleStopRecording(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", rec.Code)
	}
}

func TestExtractRecordingID(t *testing.T) {
	tests := []struct {
		path string
		want string
	}{
		{"/api/recorder/recordings/abc123", "abc123"},
		{"/api/recorder/recordings/abc123/stop", "abc123"},
		{"/api/recorder/recordings/", ""},
		{"/other/path", ""},
	}

	for _, tc := range tests {
		got := extractRecordingID(tc.path)
		if got != tc.want {
			t.Errorf("extractRecordingID(%q) = %q, want %q", tc.path, got, tc.want)
		}
	}
}

func TestCheckAuthFormats(t *testing.T) {
	s := NewServer(store.New(), "token")

	tests := []struct {
		name   string
		header string
		want   int
	}{
		{"no header", "", http.StatusUnauthorized},
		{"wrong format", "Basic dXNlcjpwYXNz", http.StatusUnauthorized},
		{"wrong token", "Bearer wrong", http.StatusUnauthorized},
		{"correct", "Bearer token", http.StatusCreated},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/recorder/recordings", bytes.NewBufferString(`{"version":1}`))
			if tc.header != "" {
				req.Header.Set("Authorization", tc.header)
			}
			rec := httptest.NewRecorder()
			s.HandleCreateRecording(rec, req)
			if rec.Code != tc.want {
				t.Errorf("status = %d, want %d", rec.Code, tc.want)
			}
		})
	}
}
