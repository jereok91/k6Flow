import { describe, expect, it } from "vitest";
import { toHistoryStatus } from "./run-status";

describe("toHistoryStatus", () => {
  it.each([
    ["finished", "completed"],
    ["completed", "completed"],
    ["failed", "failed"],
    ["errored", "failed"],
    ["aborted", "stopped"],
    ["stopped", "stopped"],
    ["queued", "running"],
    ["pending", "running"],
    ["starting", "running"],
    ["running", "running"],
    ["stopping", "running"],
  ])("maps orchestrator status %s to history status %s", (input, expected) => {
    expect(toHistoryStatus(input)).toBe(expected);
  });

  it("matches case-insensitively", () => {
    expect(toHistoryStatus("FINISHED")).toBe("completed");
    expect(toHistoryStatus("Errored")).toBe("failed");
    expect(toHistoryStatus("ABORTED")).toBe("stopped");
  });

  it("trims surrounding whitespace", () => {
    expect(toHistoryStatus("  finished  ")).toBe("completed");
    expect(toHistoryStatus("\tRunning\n")).toBe("running");
  });

  it.each([["unknown"], ["done"], [""], ["   "], [null], [undefined]])(
    "returns null for unmapped input %j",
    (input) => {
      expect(toHistoryStatus(input as string | null | undefined)).toBeNull();
    },
  );
});
