package proxy

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"k6flow/apps/recorder/internal/store"
)

func TestProxyForwardsRequest(t *testing.T) {
	// Upstream server
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Custom", "value")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("hello"))
	}))
	defer upstream.Close()

	var captured store.CaptureEntry
	proxy := New(func(entry store.CaptureEntry) {
		captured = entry
	})

	// Create request with absolute URL
	req := httptest.NewRequest(http.MethodGet, upstream.URL+"/test", nil)
	rec := httptest.NewRecorder()

	proxy.ServeHTTP(rec, req)

	// Check response
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rec.Code)
	}
	if body := rec.Body.String(); body != "hello" {
		t.Errorf("body = %q, want hello", body)
	}

	// Check captured entry
	if captured.Method != "GET" {
		t.Errorf("captured.Method = %q, want GET", captured.Method)
	}
	if !strings.HasSuffix(captured.URL, "/test") {
		t.Errorf("captured.URL = %q, want */test", captured.URL)
	}
	if captured.Status != 200 {
		t.Errorf("captured.Status = %d, want 200", captured.Status)
	}
	if captured.BodyExcerpt != "hello" {
		t.Errorf("captured.BodyExcerpt = %q, want hello", captured.BodyExcerpt)
	}
}

func TestProxyRejectsRelativeURL(t *testing.T) {
	proxy := New(nil)

	req := httptest.NewRequest(http.MethodGet, "/relative/path", nil)
	rec := httptest.NewRecorder()

	proxy.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestProxyCapturesHeaders(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Request-Id", "123")
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	var captured store.CaptureEntry
	proxy := New(func(entry store.CaptureEntry) {
		captured = entry
	})

	req := httptest.NewRequest(http.MethodGet, upstream.URL, nil)
	rec := httptest.NewRecorder()

	proxy.ServeHTTP(rec, req)

	// Check headers were captured
	found := make(map[string]bool)
	for _, h := range captured.Headers {
		found[h.Name] = true
	}

	if !found["Content-Type"] {
		t.Error("Content-Type header not captured")
	}
	if !found["X-Request-Id"] {
		t.Error("X-Request-Id header not captured")
	}
}

func TestProxyForwardsRequestBody(t *testing.T) {
	var receivedBody string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		receivedBody = string(body)
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	proxy := New(nil)

	req := httptest.NewRequest(http.MethodPost, upstream.URL, strings.NewReader(`{"data":"test"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	proxy.ServeHTTP(rec, req)

	if receivedBody != `{"data":"test"}` {
		t.Errorf("upstream received = %q, want {\"data\":\"test\"}", receivedBody)
	}
}

func TestProxyNilCapture(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	// No capture callback
	proxy := New(nil)

	req := httptest.NewRequest(http.MethodGet, upstream.URL, nil)
	rec := httptest.NewRecorder()

	// Should not panic
	proxy.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rec.Code)
	}
}

func TestTruncateBody(t *testing.T) {
	tests := []struct {
		name string
		body []byte
		want string
	}{
		{"empty", []byte{}, ""},
		{"short", []byte("hello"), "hello"},
		{"long", make([]byte, 5000), ""}, // will be truncated
		{"binary", []byte{0x00, 0x01, 0x02}, "[binary content]"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if tc.name == "long" {
				// Fill with 'a' characters
				for i := range tc.body {
					tc.body[i] = 'a'
				}
				got := truncateBody(tc.body)
				if len(got) > maxBodyExcerpt+10 {
					t.Errorf("truncateBody() len = %d, want <= %d", len(got), maxBodyExcerpt+10)
				}
				if !strings.HasSuffix(got, "...") {
					t.Error("truncateBody() should end with ...")
				}
			} else {
				got := truncateBody(tc.body)
				if got != tc.want {
					t.Errorf("truncateBody() = %q, want %q", got, tc.want)
				}
			}
		})
	}
}

func TestIsRedactedHeader(t *testing.T) {
	tests := []struct {
		name     string
		redacted bool
	}{
		{"Authorization", true},
		{"authorization", true},
		{"X-Api-Key", true},
		{"Cookie", true},
		{"Set-Cookie", true},
		{"X-Auth-Token", true},
		{"Content-Type", false},
		{"Accept", false},
		{"X-Request-Id", false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := IsRedactedHeader(tc.name)
			if got != tc.redacted {
				t.Errorf("IsRedactedHeader(%q) = %v, want %v", tc.name, got, tc.redacted)
			}
		})
	}
}

func TestIsTextContent(t *testing.T) {
	tests := []struct {
		name   string
		body   []byte
		isText bool
	}{
		{"empty", []byte{}, true},
		{"json", []byte(`{"key":"value"}`), true},
		{"html", []byte("<html><body>test</body></html>"), true},
		{"binary null", []byte{0x00, 0x01, 0x02}, false},
		{"utf8", []byte("Héllo Wörld"), true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := isTextContent(tc.body)
			if got != tc.isText {
				t.Errorf("isTextContent() = %v, want %v", got, tc.isText)
			}
		})
	}
}
