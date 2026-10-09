// Package diagnostic validates the bounded application metric protocol. Raw
// output and native tags never become part of a persisted snapshot.
package diagnostic

import (
	"bytes"
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"unicode/utf8"
)

const Metric = "k6flow_diagnostic_event"
const MaxEvents = 201

type Metadata struct {
	NodeIDs []string `json:"nodeIds"`
}

func (m Metadata) Validate() error {
	if len(m.NodeIDs) < 1 || len(m.NodeIDs) > 100 {
		return errors.New("invalid diagnostic metadata")
	}
	seen := map[string]bool{}
	for _, id := range m.NodeIDs {
		if id == "" || len(id) > 128 || !utf8.ValidString(id) || seen[id] {
			return errors.New("invalid diagnostic metadata")
		}
		seen[id] = true
	}
	return nil
}

type Event struct {
	Seq        int     `json:"seq"`
	NodeID     string  `json:"nodeId"`
	Event      string  `json:"event"`
	ElapsedMs  float64 `json:"elapsedMs"`
	HTTPStatus int     `json:"httpStatus"`
	Outcome    string  `json:"outcome"`
	Reason     string  `json:"reason"`
}

type Snapshot struct {
	State    string  `json:"state"`
	Events   []Event `json:"events"`
	invalid  bool
	terminal bool
}

func New() Snapshot {
	return Snapshot{State: "pending", Events: []Event{}}
}

func Copy(s Snapshot) Snapshot {
	s.Events = append([]Event{}, s.Events...)
	return s
}

func Invalidate(s *Snapshot) {
	if !s.terminal {
		s.invalid = true
	}
}

// Consume recognizes only the custom metric. Invalid custom lines are consumed
// as well, keeping malformed trace points away from the normal summary parser.
func Consume(s *Snapshot, m Metadata, line []byte) bool {
	var envelope struct {
		Type   string          `json:"type"`
		Metric json.RawMessage `json:"metric"`
		Data   json.RawMessage `json:"data"`
	}
	err := json.Unmarshal(line, &envelope)
	var metric string
	_ = json.Unmarshal(envelope.Metric, &metric)
	custom := metric == Metric
	if err != nil {
		custom = bytes.Contains(line, []byte(Metric))
	}
	if !custom {
		return false
	}
	if s.terminal {
		return true
	}
	if err == nil && envelope.Type == "Metric" {
		var declaration struct { Name string `json:"name"`; Type string `json:"type"` }
		if json.Unmarshal(envelope.Data, &declaration) != nil || declaration.Name != Metric || declaration.Type != "counter" {
			Invalidate(s)
		}
		return true
	}
	if err != nil || !utf8.Valid(line) || envelope.Type != "Point" {
		Invalidate(s)
		return true
	}
	if s.invalid {
		return true
	}
	var data struct {
		Value float64           `json:"value"`
		Tags  map[string]string `json:"tags"`
	}
	var required map[string]json.RawMessage
	if json.Unmarshal(envelope.Data, &required) != nil || required["value"] == nil ||
		bytes.Equal(required["value"], []byte("null")) || json.Unmarshal(envelope.Data, &data) != nil {
		Invalidate(s)
		return true
	}
	// The owned executor disables system tags. No speculative default-tag
	// allowlist is necessary: custom points have exactly these six fields.
	tags := data.Tags
	var rawTags map[string]json.RawMessage
	if json.Unmarshal(required["tags"], &rawTags) != nil {
		Invalidate(s)
		return true
	}
	for _, value := range rawTags {
		trimmed := bytes.TrimSpace(value)
		if len(trimmed) == 0 || trimmed[0] != '"' {
			Invalidate(s)
			return true
		}
	}
	if len(tags) != 6 {
		Invalidate(s)
		return true
	}
	for _, key := range []string{"seq", "nodeId", "event", "httpStatus", "outcome", "reason"} {
		if _, ok := tags[key]; !ok {
			Invalidate(s)
			return true
		}
	}
	seq, seqErr := strconv.Atoi(tags["seq"])
	status, statusErr := strconv.Atoi(tags["httpStatus"])
	event := Event{
		Seq: seq, NodeID: tags["nodeId"], Event: tags["event"], ElapsedMs: data.Value,
		HTTPStatus: status, Outcome: tags["outcome"], Reason: tags["reason"],
	}
	if seqErr != nil || statusErr != nil || strconv.Itoa(seq) != tags["seq"] ||
		strconv.Itoa(status) != tags["httpStatus"] || !valid(s, m, event) {
		Invalidate(s)
		return true
	}
	s.Events = append(s.Events, event)
	return true
}

func valid(s *Snapshot, m Metadata, e Event) bool {
	if len(s.Events) >= MaxEvents || e.Seq != len(s.Events)+1 || e.HTTPStatus < 0 || e.HTTPStatus > 599 ||
		math.IsNaN(e.ElapsedMs) || math.IsInf(e.ElapsedMs, 0) || e.ElapsedMs < 0 || e.ElapsedMs > 30000 {
		return false
	}
	if e.Event != "exit" && (e.ElapsedMs != 0 || e.HTTPStatus != 0) {
		return false
	}
	index, active, failed := 0, "", false
	for _, prior := range s.Events {
		switch prior.Event {
		case "complete":
			return false
		case "enter":
			active = prior.NodeID
		case "exit":
			active = ""
			index++
			failed = failed || prior.Outcome == "failure"
		case "skipped":
			index++
		}
	}
	if e.Event == "complete" {
		return e.NodeID == "" && active == "" && index == len(m.NodeIDs) &&
			((failed && e.Outcome == "failure" && e.Reason == "prior-failure") ||
				(!failed && e.Outcome == "success" && e.Reason == "none"))
	}
	if index >= len(m.NodeIDs) || e.NodeID != m.NodeIDs[index] || len(e.NodeID) > 128 || !utf8.ValidString(e.NodeID) {
		return false
	}
	switch e.Event {
	case "enter":
		return active == "" && !failed && e.Outcome == "pending" && e.Reason == "none"
	case "exit":
		return active == e.NodeID && ((e.Outcome == "success" && e.Reason == "none") ||
			(e.Outcome == "failure" && oneOf(e.Reason, "http", "extraction", "check", "pool", "exception")))
	case "skipped":
		return active == "" && e.Outcome == "skipped" &&
			(e.Reason == "disabled" || (failed && e.Reason == "prior-failure"))
	}
	return false
}

func oneOf(s string, values ...string) bool {
	for _, value := range values {
		if s == value {
			return true
		}
	}
	return false
}

// Finish runs while holding the same store lock as the run transition. A marker
// is not terminal until output has flushed and the runtime outcome is known.
func Finish(s *Snapshot, status string) {
	if s.terminal {
		return
	}
	s.terminal = true
	s.State = "incomplete"
	if status == "stopped" || status == "aborted" {
		s.State = "interrupted"
		return
	}
	if s.invalid || len(s.Events) == 0 {
		return
	}
	last := s.Events[len(s.Events)-1]
	if last.Event != "complete" {
		return
	}
	if last.Outcome == "failure" {
		s.State = "failed"
		return
	}
	if status == "finished" {
		s.State = "complete"
	}
}

// Entry never imports submitted options. Namespace checks preserve optional
// hooks, avoiding link errors when setup/teardown are absent.
const Entry = `import * as submitted from './script.js';
export const options = {
  scenarios: { diagnostic: { executor: 'shared-iterations', vus: 1, iterations: 1, maxDuration: '30s', gracefulStop: '0s' } },
  systemTags: [], setupTimeout: '30s', teardownTimeout: '30s'
};
if (typeof submitted.default !== 'function') throw new Error('Invalid diagnostic entrypoint');
export function setup() { if (typeof submitted.setup === 'function') return submitted.setup(); }
export default function(data) { return submitted.default(data); }
export function teardown(data) { if (typeof submitted.teardown === 'function') return submitted.teardown(data); }
`
