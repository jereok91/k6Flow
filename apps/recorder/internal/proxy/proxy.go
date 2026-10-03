// Package proxy provides an HTTP forward proxy that captures traffic.
package proxy

import (
	"bytes"
	"io"
	"net/http"
	"strings"

	"k6flow/apps/recorder/internal/store"
)

const maxBodyExcerpt = 4096 // 4KB body excerpt limit

// CaptureFunc is called for each captured request/response pair.
type CaptureFunc func(entry store.CaptureEntry)

// Proxy is an HTTP forward proxy that captures traffic.
type Proxy struct {
	client    *http.Client
	onCapture CaptureFunc
}

// New creates a new proxy with the given capture callback.
func New(onCapture CaptureFunc) *Proxy {
	return &Proxy{
		client:    &http.Client{},
		onCapture: onCapture,
	}
}

// ServeHTTP handles proxy requests.
func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Forward proxy: the request URL is absolute
	if !r.URL.IsAbs() {
		http.Error(w, "proxy requires absolute URL", http.StatusBadRequest)
		return
	}

	// Create outbound request
	outReq, err := http.NewRequestWithContext(r.Context(), r.Method, r.URL.String(), r.Body)
	if err != nil {
		http.Error(w, "failed to create request", http.StatusInternalServerError)
		return
	}

	// Copy headers (except hop-by-hop)
	copyHeaders(outReq.Header, r.Header)

	// Execute request
	resp, err := p.client.Do(outReq)
	if err != nil {
		http.Error(w, "upstream request failed", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	// Read response body for capture
	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		http.Error(w, "failed to read response", http.StatusBadGateway)
		return
	}

	// Capture the request/response
	if p.onCapture != nil {
		entry := store.CaptureEntry{
			Method:      r.Method,
			URL:         r.URL.String(),
			Status:      resp.StatusCode,
			Headers:     extractHeaders(resp.Header),
			BodyExcerpt: truncateBody(bodyBytes),
			Redacted:    false,
		}
		p.onCapture(entry)
	}

	// Forward response to client
	copyHeaders(w.Header(), resp.Header)
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(bodyBytes)
}

// copyHeaders copies headers, excluding hop-by-hop headers.
func copyHeaders(dst, src http.Header) {
	hopByHop := map[string]bool{
		"Connection":          true,
		"Keep-Alive":          true,
		"Proxy-Authenticate":  true,
		"Proxy-Authorization": true,
		"Te":                  true,
		"Trailers":            true,
		"Transfer-Encoding":   true,
		"Upgrade":             true,
	}

	for key, values := range src {
		if hopByHop[key] {
			continue
		}
		for _, value := range values {
			dst.Add(key, value)
		}
	}
}

// extractHeaders converts http.Header to []HeaderEntry.
func extractHeaders(h http.Header) []store.HeaderEntry {
	entries := make([]store.HeaderEntry, 0, len(h))
	for name, values := range h {
		for _, value := range values {
			entries = append(entries, store.HeaderEntry{Name: name, Value: value})
		}
	}
	return entries
}

// truncateBody returns a body excerpt up to maxBodyExcerpt bytes.
// Returns empty string for binary content.
func truncateBody(body []byte) string {
	if len(body) == 0 {
		return ""
	}

	// Skip binary content
	if !isTextContent(body) {
		return "[binary content]"
	}

	if len(body) <= maxBodyExcerpt {
		return string(body)
	}
	return string(body[:maxBodyExcerpt]) + "..."
}

// isTextContent checks if the body appears to be text.
func isTextContent(body []byte) bool {
	// Check for null bytes (common in binary)
	if bytes.Contains(body[:min(512, len(body))], []byte{0}) {
		return false
	}

	// Check if content looks like UTF-8 text
	for _, b := range body[:min(512, len(body))] {
		if b < 0x09 || (b > 0x0D && b < 0x20 && b != 0x1B) {
			return false
		}
	}
	return true
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// IsRedactedHeader returns true if the header should be redacted.
func IsRedactedHeader(name string) bool {
	lower := strings.ToLower(name)
	return strings.Contains(lower, "authorization") ||
		strings.Contains(lower, "cookie") ||
		strings.Contains(lower, "token") ||
		strings.Contains(lower, "secret") ||
		strings.Contains(lower, "password") ||
		strings.Contains(lower, "api-key") ||
		strings.Contains(lower, "apikey")
}
