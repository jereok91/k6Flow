package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"k6flow/apps/orchestrator/internal/diagnostic"
	"k6flow/apps/orchestrator/internal/runs"
)

func TestDiagnosticEndpointAuthAndSnapshot(t *testing.T) {
	store := runs.NewStore()
	run, err := store.Create(runs.Run{Mode: "diagnostic", Diagnostic: &diagnostic.Metadata{NodeIDs: []string{"a"}}})
	if err != nil {
		t.Fatal(err)
	}
	handler := NewHandler(Deps{Store: store, Token: "test-token"})
	for _, tc := range []struct {
		path, token string
		status      int
	}{
		{run.ID, "", 401},
		{"missing", "test-token", 404},
		{run.ID, "test-token", 200},
	} {
		request := httptest.NewRequest(http.MethodGet, "/api/runs/"+tc.path+"/diagnostic", nil)
		if tc.token != "" {
			request.Header.Set("Authorization", "Bearer "+tc.token)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != tc.status {
			t.Fatalf("status %d body %s", response.Code, response.Body.String())
		}
		if tc.status == 200 && (!strings.Contains(response.Body.String(), `"state":"pending"`) || response.Header().Get("Cache-Control") != "no-store") {
			t.Fatal(response.Body.String())
		}
	}
}

func TestDiagnosticStartContract(t *testing.T) {
	base := `{"version":1,"script":"export default function(){}","vus":2,"durationMs":1000,"cpuMillis":100,"memoryMiB":128`
	for _, tc := range []struct {
		name, extra string
		ok          bool
	}{
		{"omitted", "}", true},
		{"load", `,"mode":"load"}`, true},
		{"diagnostic", `,"mode":"diagnostic","diagnostic":{"nodeIds":["a"]}}`, true},
		{"null mode", `,"mode":null}`, false},
		{"boolean mode", `,"mode":true}`, false},
		{"mode casing", `,"Mode":"load"}`, false},
		{"unknown mode", `,"mode":"debug"}`, false},
		{"missing metadata", `,"mode":"diagnostic"}`, false},
		{"null metadata", `,"mode":"diagnostic","diagnostic":null}`, false},
		{"wrong metadata shape", `,"mode":"diagnostic","diagnostic":[]}`, false},
		{"wrong casing", `,"mode":"diagnostic","diagnostic":{"NodeIds":["a"]}}`, false},
		{"load metadata", `,"diagnostic":{"nodeIds":["a"]}}`, false},
		{"unknown field", `,"mode":"diagnostic","diagnostic":{"nodeIds":["a"],"secret":"x"}}`, false},
		{"duplicate", `,"mode":"diagnostic","diagnostic":{"nodeIds":["a","a"]}}`, false},
		{"empty", `,"mode":"diagnostic","diagnostic":{"nodeIds":[]}}`, false},
		{"utf8", `,"mode":"diagnostic","diagnostic":{"nodeIds":["` + strings.Repeat("é", 65) + `"]}}`, false},
		{"trailing", `,"mode":"diagnostic","diagnostic":{"nodeIds":["a"]}} {}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := decodeStart([]byte(base + tc.extra))
			if (err == nil) != tc.ok {
				t.Fatalf("err=%v", err)
			}
		})
	}
}
