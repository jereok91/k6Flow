package diagnostic

import (
	"fmt"
	"strings"
	"testing"
)

func point(seq int, id, event, outcome, reason string, value int) []byte {
	return []byte(fmt.Sprintf(`{"type":"Point","metric":"k6flow_diagnostic_event","data":{"value":%d,"tags":{"seq":"%d","nodeId":%q,"event":%q,"httpStatus":"0","outcome":%q,"reason":%q}}}`, value, seq, id, event, outcome, reason))
}

func TestCompletionRejectsNullNodeID(t *testing.T) {
	s := New()
	m := Metadata{NodeIDs: []string{"a"}}
	Consume(&s, m, point(1, "a", "skipped", "skipped", "disabled", 0))
	completion := strings.Replace(string(point(2, "", "complete", "success", "none", 0)), `"nodeId":""`, `"nodeId":null`, 1)
	Consume(&s, m, []byte(completion))
	Finish(&s, "finished")
	if s.State != "incomplete" {
		t.Fatal("null tag accepted", s.State)
	}
}

func TestRealCounterDeclarationDoesNotInvalidatePoints(t *testing.T) {
	s := New()
	m := Metadata{NodeIDs: []string{"a"}}
	Consume(&s, m, []byte(`{"type":"Metric","metric":"k6flow_diagnostic_event","data":{"name":"k6flow_diagnostic_event","type":"counter","contains":"default","thresholds":[],"submetrics":null}}`))
	Consume(&s, m, point(1, "a", "skipped", "skipped", "disabled", 0))
	Consume(&s, m, point(2, "", "complete", "success", "none", 0))
	Finish(&s, "finished")
	if s.State != "complete" {
		t.Fatal(s.State)
	}
}

func TestTraceLifecycle(t *testing.T) {
	m := Metadata{NodeIDs: []string{"a", "b"}}
	s := New()
	for _, p := range [][]byte{
		point(1, "a", "enter", "pending", "none", 0),
		point(2, "a", "exit", "failure", "check", 5),
		point(3, "b", "skipped", "skipped", "prior-failure", 0),
		point(4, "", "complete", "failure", "prior-failure", 0),
	} {
		if !Consume(&s, m, p) {
			t.Fatal("not custom")
		}
	}
	Finish(&s, "finished")
	if s.State != "failed" || len(s.Events) != 4 {
		t.Fatalf("%+v", s)
	}
	before := len(s.Events)
	Consume(&s, m, point(5, "", "complete", "success", "none", 0))
	if len(s.Events) != before {
		t.Fatal("late write")
	}
}

func TestTraceRejects(t *testing.T) {
	good := string(point(1, "a", "enter", "pending", "none", 0))
	for name, p := range map[string]string{
		"unknown": string(point(1, "unknown", "enter", "pending", "none", 0)),
		"gap": string(point(2, "a", "enter", "pending", "none", 0)),
		"exit first": string(point(1, "a", "exit", "success", "none", 0)),
		"timing": string(point(1, "a", "enter", "pending", "none", 1)),
		"extra": strings.Replace(good, `"seq":"1"`, `"url":"secret","seq":"1"`, 1),
		"fraction": strings.Replace(good, `"seq":"1"`, `"seq":"1.5"`, 1),
		"number": strings.Replace(good, `"seq":"1"`, `"seq":1`, 1),
		"nonfinite": strings.Replace(good, `"value":0`, `"value":"NaN"`, 1),
		"numeric string value": strings.Replace(good, `"value":0`, `"value":"0"`, 1),
		"overflow": strings.Replace(good, `"value":0`, `"value":1e999`, 1),
		"null value": strings.Replace(good, `"value":0`, `"value":null`, 1),
		"negative status": strings.Replace(good, `"httpStatus":"0"`, `"httpStatus":"-1"`, 1),
		"status overflow": strings.Replace(good, `"httpStatus":"0"`, `"httpStatus":"600"`, 1),
		"null tags": good[:strings.Index(good, `"tags":`)] + `"tags":null}}`,
		"oversize tag": strings.Replace(good, `"nodeId":"a"`, `"nodeId":"`+strings.Repeat("a", 129)+`"`, 1),
	} {
		t.Run(name, func(t *testing.T) {
			s := New()
			Consume(&s, Metadata{NodeIDs: []string{"a"}}, []byte(p))
			Finish(&s, "finished")
			if s.State != "incomplete" {
				t.Fatalf("%+v", s)
			}
		})
	}
}

func TestCompletionReconciliation(t *testing.T) {
	for _, status := range []string{"finished", "failed", "stopped"} {
		t.Run(status, func(t *testing.T) {
			s := New()
			m := Metadata{NodeIDs: []string{"a"}}
			Consume(&s, m, point(1, "a", "skipped", "skipped", "disabled", 0))
			Consume(&s, m, point(2, "", "complete", "success", "none", 0))
			Finish(&s, status)
			want := map[string]string{"finished": "complete", "failed": "incomplete", "stopped": "interrupted"}[status]
			if s.State != want {
				t.Fatal(s.State)
			}
		})
	}
	s := New()
	Finish(&s, "finished")
	if s.State != "incomplete" {
		t.Fatal(s.State)
	}
}

func TestTraceBoundsAndCompletionMismatch(t *testing.T) {
	metadata := Metadata{}
	for i := 0; i < 100; i++ {
		metadata.NodeIDs = append(metadata.NodeIDs, fmt.Sprint(i))
	}
	s := New()
	for i, id := range metadata.NodeIDs {
		Consume(&s, metadata, point(2*i+1, id, "enter", "pending", "none", 0))
		Consume(&s, metadata, point(2*i+2, id, "exit", "success", "none", 30000))
	}
	Consume(&s, metadata, point(201, "", "complete", "success", "none", 0))
	if len(s.Events) != 201 {
		t.Fatalf("events=%d", len(s.Events))
	}
	complete := Copy(s)
	Finish(&complete, "finished")
	if complete.State != "complete" {
		t.Fatal(complete.State)
	}
	Consume(&s, metadata, point(202, "", "complete", "success", "none", 0))
	Finish(&s, "finished")
	if s.State != "incomplete" || len(s.Events) != 201 {
		t.Fatal(s.State)
	}
	m := Metadata{NodeIDs: []string{"a"}}
	s = New()
	Consume(&s, m, point(1, "a", "enter", "pending", "none", 0))
	Consume(&s, m, point(2, "a", "exit", "failure", "http", 0))
	Consume(&s, m, point(3, "", "complete", "success", "none", 0))
	Finish(&s, "finished")
	if s.State != "incomplete" {
		t.Fatal("contradictory completion accepted")
	}
}

func TestMetadata(t *testing.T) {
	for _, ids := range [][]string{nil, {""}, {"a", "a"}, {strings.Repeat("é", 65)}, make([]string, 101)} {
		if (Metadata{NodeIDs: ids}).Validate() == nil {
			t.Fatal("accepted", ids)
		}
	}
}
