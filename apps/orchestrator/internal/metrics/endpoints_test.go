package metrics

import (
	"encoding/json"
	"testing"
)

func decodeMap(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("unmarshal %s: %v", raw, err)
	}
	return m
}

func assertKeys(t *testing.T, obj map[string]any, want ...string) {
	t.Helper()
	if len(obj) != len(want) {
		t.Errorf("keys = %v, want exactly %v", obj, want)
	}
	for _, k := range want {
		if _, ok := obj[k]; !ok {
			t.Errorf("missing key %q in %v", k, obj)
		}
	}
}

func TestEndpointsJSONIsFlatWithErrorRate(t *testing.T) {
	tr := NewEndpointsTracker(20)
	for i := 0; i < 4; i++ {
		tr.RecordRequest("GET", "https://api.test/users/1", "users", 10)
	}
	tr.RecordFailure("GET", "https://api.test/users/1", "users", 500, "1500", "boom", 0, 1000)

	raw, err := tr.GetEndpointsJSON()
	if err != nil {
		t.Fatal(err)
	}
	m := decodeMap(t, raw)
	assertKeys(t, m, "version", "endpoints")
	if m["version"].(float64) != 1 {
		t.Errorf("version = %v", m["version"])
	}
	eps := m["endpoints"].([]any)
	if len(eps) != 1 {
		t.Fatalf("endpoints = %d, want 1 (failure must not create a second row): %s", len(eps), raw)
	}
	ep := eps[0].(map[string]any)
	assertKeys(t, ep, "method", "url", "name", "requests", "failures", "errorRate",
		"avgDurationMs", "minDurationMs", "maxDurationMs", "p95DurationMs")
	if ep["method"] != "GET" || ep["url"] != "https://api.test/users/1" || ep["name"] != "users" {
		t.Errorf("identity = %v/%v/%v", ep["method"], ep["url"], ep["name"])
	}
	if ep["requests"].(float64) != 4 || ep["failures"].(float64) != 1 {
		t.Errorf("requests/failures = %v/%v, want 4/1", ep["requests"], ep["failures"])
	}
	if ep["errorRate"].(float64) != 0.25 {
		t.Errorf("errorRate = %v, want 0.25", ep["errorRate"])
	}
}

func TestEndpointsErrorRateZeroWithoutRequests(t *testing.T) {
	tr := NewEndpointsTracker(20)
	tr.RecordFailure("GET", "https://x", "", 0, "", "dial", 0, 1)
	eps := tr.EndpointRows()
	if len(eps) != 1 || eps[0].ErrorRate != 0 || eps[0].Failures != 1 {
		t.Fatalf("rows = %+v", eps)
	}
}

func TestEndpointsGroupByNameKeepsFirstURL(t *testing.T) {
	tr := NewEndpointsTracker(20)
	tr.RecordRequest("GET", "https://api.test/users/1", "users", 10)
	tr.RecordRequest("GET", "https://api.test/users/2", "users", 30)
	tr.RecordRequest("POST", "https://api.test/users/2", "users", 30) // other method = other row
	rows := tr.EndpointRows()
	if len(rows) != 2 {
		t.Fatalf("rows = %d, want 2: %+v", len(rows), rows)
	}
	get := rows[0]
	if get.Method != "GET" || get.Requests != 2 || get.URL != "https://api.test/users/1" {
		t.Errorf("GET row = %+v", get)
	}
	if get.MinDurationMs != 10 || get.MaxDurationMs != 30 || get.AvgDurationMs != 20 {
		t.Errorf("durations = %+v", get)
	}
}

func TestEndpointsSortedByRequestsDesc(t *testing.T) {
	tr := NewEndpointsTracker(20)
	tr.RecordRequest("GET", "https://a", "", 1)
	for i := 0; i < 3; i++ {
		tr.RecordRequest("GET", "https://b", "", 1)
	}
	rows := tr.EndpointRows()
	if len(rows) != 2 || rows[0].URL != "https://b" || rows[1].URL != "https://a" {
		t.Fatalf("order = %+v", rows)
	}
}

func TestFailuresJSONIsFlat(t *testing.T) {
	tr := NewEndpointsTracker(20)
	tr.RecordFailure("POST", "https://api.test/login", "login", 0, "1211", "dial: i/o timeout", 0, 1000)
	tr.RecordFailure("POST", "https://api.test/login", "login", 0, "1211", "dial: connection refused", 0, 2000)
	tr.RecordFailure("POST", "https://api.test/login", "login", 503, "1503", "", 0, 1500)

	raw, err := tr.GetFailuresJSON()
	if err != nil {
		t.Fatal(err)
	}
	m := decodeMap(t, raw)
	assertKeys(t, m, "version", "failures")
	fs := m["failures"].([]any)
	if len(fs) != 2 {
		t.Fatalf("failures = %d, want 2: %s", len(fs), raw)
	}
	f := fs[0].(map[string]any) // count desc → network group first
	assertKeys(t, f, "method", "url", "status", "errorCode", "count", "lastError", "lastSeenMs")
	if f["method"] != "POST" || f["url"] != "https://api.test/login" {
		t.Errorf("identity = %v %v", f["method"], f["url"])
	}
	if f["status"].(float64) != 0 || f["errorCode"] != "1211" || f["count"].(float64) != 2 {
		t.Errorf("group = %v", f)
	}
	if f["lastError"] != "dial: connection refused" || f["lastSeenMs"].(float64) != 2000 {
		t.Errorf("last = %v / %v", f["lastError"], f["lastSeenMs"])
	}
	if s := fs[1].(map[string]any)["status"].(float64); s != 503 {
		t.Errorf("second group status = %v", s)
	}
}

func TestFailureStatusKeyDistinguishesLargeCodes(t *testing.T) {
	tr := NewEndpointsTracker(20)
	tr.RecordFailure("GET", "https://x", "", 500, "", "", 0, 1)
	tr.RecordFailure("GET", "https://x", "", 502, "", "", 0, 1)
	if got := len(tr.FailureRows()); got != 2 {
		t.Fatalf("groups = %d, want 2", got)
	}
}
