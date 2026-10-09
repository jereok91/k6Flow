import { expect, it } from "vitest";
import { RunNotifications } from "./run-notifications";

it("deduplicates running and terminal observations across subscribers and aliases", () => {
  const events = new RunNotifications();
  expect(events.observe("a", "queued")).toBeNull();
  expect(events.observe("a", " RUNNING ")).toBe("running");
  expect(events.observe("a", "running")).toBeNull();
  expect(events.observe("a", "mystery")).toBeNull();
  expect(events.observe("a", "finished")).toBe("completed");
  expect(events.observe("a", "completed")).toBeNull();
  expect(events.observe("a", "running")).toBeNull();
  expect(events.observe("b", "errored")).toBe("failed");
  expect(events.observe("c", "stopping")).toBeNull();
  expect(events.observe("c", "aborted")).toBe("stopped");
});
