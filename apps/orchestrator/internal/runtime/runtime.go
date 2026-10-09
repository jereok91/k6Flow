// Package runtime defines the container runtime abstraction and a thread-safe test fake.
package runtime

import (
	"context"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"
)

// Spec describes a container to create: image, command/args, env, limits in
// contract units (CPU millis, memory MiB), labels and network.
type Spec struct {
	// DiagnosticEntry is delivered only to the fixed diagnostic entry path.
	// It is not container environment and is never logged.
	DiagnosticEntry []byte
	Image, Network       string
	Command, Args        []string
	Env, Labels          map[string]string
	CPUMillis, MemoryMiB int
}

// ContainerRuntime abstracts the container engine: Docker SDK (K6F2-03) or
// FakeRuntime; ListLabeled serves orphan reconciliation, Output the JSON stream.
type ContainerRuntime interface {
	Create(ctx context.Context, spec Spec) (string, error)
	Start(ctx context.Context, containerID string) error
	Wait(ctx context.Context, containerID string) (int, error)
	Stop(ctx context.Context, containerID string, timeout time.Duration) error
	Remove(ctx context.Context, containerID string, force bool) error
	ListLabeled(ctx context.Context) ([]string, error)
	Output(ctx context.Context, containerID string) (io.ReadCloser, error)
}

// FakeRuntime is a thread-safe ContainerRuntime test double: scripted exits/
// outputs/listings, errors injected by "Op" or "Op:id", every call recorded in order.
type FakeRuntime struct {
	mu         sync.Mutex
	calls      []string
	specs      []Spec
	errors     map[string]error
	exitCodes  map[string]int
	outputs    map[string]string
	containers []string
	created    int
}

func copySpec(spec Spec) Spec {
	spec.DiagnosticEntry = append([]byte(nil), spec.DiagnosticEntry...)
	spec.Command = append([]string(nil), spec.Command...)
	spec.Args = append([]string(nil), spec.Args...)
	copyMap := func(in map[string]string) map[string]string {
		if in == nil {
			return nil
		}
		out := make(map[string]string, len(in))
		for k, v := range in {
			out[k] = v
		}
		return out
	}
	spec.Env, spec.Labels = copyMap(spec.Env), copyMap(spec.Labels)
	return spec
}

// NewFakeRuntime returns an empty fake runtime.
func NewFakeRuntime() *FakeRuntime {
	return &FakeRuntime{errors: map[string]error{}, exitCodes: map[string]int{}, outputs: map[string]string{}}
}

// record appends a call label and returns its injected error, if any.
func (f *FakeRuntime) record(label string) error {
	f.calls = append(f.calls, label)
	if err, ok := f.errors[label]; ok {
		return err
	}
	if op, _, found := strings.Cut(label, ":"); found {
		return f.errors[op]
	}
	return nil
}

// Calls returns the recorded call labels in order.
func (f *FakeRuntime) Calls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}

// Specs returns the recorded creation specs in order.
func (f *FakeRuntime) Specs() []Spec {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]Spec, len(f.specs))
	for i, spec := range f.specs {
		out[i] = copySpec(spec)
	}
	return out
}

// SetError injects a persistent error keyed by "Op" or "Op:containerID".
func (f *FakeRuntime) SetError(key string, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.errors[key] = err
}

// SetExitCode scripts the exit code Wait reports for a container.
func (f *FakeRuntime) SetExitCode(containerID string, code int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.exitCodes[containerID] = code
}

// SetOutput scripts the JSON stream Output returns for a container.
func (f *FakeRuntime) SetOutput(containerID, output string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.outputs[containerID] = output
}

// SetContainers scripts the ListLabeled result used by orphan reconciliation.
func (f *FakeRuntime) SetContainers(ids []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.containers = append([]string(nil), ids...)
}

// Create records the call and returns the next generated "fake-N" id.
func (f *FakeRuntime) Create(ctx context.Context, spec Spec) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.created++
	id := fmt.Sprintf("fake-%d", f.created)
	if err := f.record("Create:" + id); err != nil {
		return "", err
	}
	f.specs = append(f.specs, copySpec(spec))
	return id, nil
}

// Start records the call and returns its injected error, if any.
func (f *FakeRuntime) Start(ctx context.Context, containerID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.record("Start:" + containerID)
}

// Wait records the call and reports the scripted exit code (default 0).
func (f *FakeRuntime) Wait(ctx context.Context, containerID string) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.record("Wait:" + containerID); err != nil {
		return 0, err
	}
	return f.exitCodes[containerID], nil
}

// Stop records the call so Stop-before-Remove ordering is assertable.
func (f *FakeRuntime) Stop(ctx context.Context, containerID string, timeout time.Duration) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.record("Stop:" + containerID)
}

// Remove records the call even on failure paths, so guaranteed removal is assertable.
func (f *FakeRuntime) Remove(ctx context.Context, containerID string, force bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.record("Remove:" + containerID)
}

// ListLabeled records the call and returns the scripted container ids.
func (f *FakeRuntime) ListLabeled(ctx context.Context) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.record("ListLabeled"); err != nil {
		return nil, err
	}
	return append([]string(nil), f.containers...), nil
}

// Output records the call and returns the scripted JSON stream.
func (f *FakeRuntime) Output(ctx context.Context, containerID string) (io.ReadCloser, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.record("Output:" + containerID); err != nil {
		return nil, err
	}
	return io.NopCloser(strings.NewReader(f.outputs[containerID])), nil
}
