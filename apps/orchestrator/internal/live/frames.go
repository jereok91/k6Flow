// Per-run latest metrics frame cache (polling fallback for the metrics WS).
//
// The metrics WebSocket is the primary delivery path for window frames. When a
// browser cannot open it, RunExecutionPanel falls back to polling and needs the
// same frame over REST (`GET /api/runs/{runId}/metrics`). The live Server
// already implements metrics.FrameSink, so it is the single place that sees
// every frame: the last frame per run is retained here and read back through
// Server.LastFrame.
//
// Bounded by construction: at most maxRetainedFrames runs are retained, the
// oldest insertion is evicted when a new run arrives, and a run's entry is
// dropped at its terminal end (Server.CloseRun, which sinkAdapter triggers from
// the engine's OnRunFinished). Every method holds the cache mutex across map
// work only — no channel sends, no I/O — so OnFrame stays non-blocking exactly
// as the hub requires (R3-blocking-sink-stalls-completion).

package live

import (
	"sync"

	"k6flow/apps/orchestrator/internal/metrics"
)

// maxRetainedFrames caps the number of runs whose latest frame is retained
// (one frame per run, so this is also the frame ceiling).
const maxRetainedFrames = 256

// frameCache keeps the latest metrics frame per run, keyed by frame.RunID.
type frameCache struct {
	mu     sync.Mutex
	max    int
	frames map[string]metrics.MetricsFrame
	order  []string // insertion order of the retained runs, oldest first
}

func newFrameCache(max int) *frameCache {
	if max <= 0 {
		max = maxRetainedFrames
	}
	return &frameCache{
		max:    max,
		frames: make(map[string]metrics.MetricsFrame, max),
	}
}

// store records frame as the run's latest window. A new run evicts the oldest
// insertion when the cache is full; refreshing a retained run keeps its
// position, so a busy run can never evict its peers.
func (c *frameCache) store(frame metrics.MetricsFrame) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, retained := c.frames[frame.RunID]; !retained {
		for len(c.order) >= c.max {
			delete(c.frames, c.order[0])
			c.order = append(c.order[:0], c.order[1:]...)
		}
		c.order = append(c.order, frame.RunID)
	}
	c.frames[frame.RunID] = frame
}

// last returns the run's latest frame; false means the run is unknown or has
// not produced a window yet.
func (c *frameCache) last(runID string) (metrics.MetricsFrame, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	frame, ok := c.frames[runID]
	return frame, ok
}

// drop forgets runID (terminal end). Unknown runIDs are a no-op.
func (c *frameCache) drop(runID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, retained := c.frames[runID]; !retained {
		return
	}
	delete(c.frames, runID)
	for i, id := range c.order {
		if id == runID {
			c.order = append(c.order[:i], c.order[i+1:]...)
			return
		}
	}
}
