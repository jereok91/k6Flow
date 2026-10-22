/**
 * The scenarios list, the scenario detail page and the recorder review page link
 * into `/editor`, and the editor is the only reader of those parameters. A
 * writer/reader disagreement opened the editor with nothing loaded: the list
 * wrote `?id=<uuid>` and the editor read `id` as a number, so `parseInt` produced
 * NaN and the load was skipped. This suite pins the shared contract instead of
 * either side alone.
 */

import { describe, expect, it } from "vitest";
import {
  resolveEditorRunId,
  resolveEditorScenarioId,
  runEditorHref,
  scenarioEditorHref,
} from "./editor-route-params";

const UUID = "f419a367-e2d5-463b-8aec-c005fd3c65f8";

const paramsOf = (search: string) => new URLSearchParams(search);
const paramsOfHref = (href: string) => paramsOf(href.slice(href.indexOf("?")));

describe("editor route scenario parameter", () => {
  it("resolves the id its own editor link writes", () => {
    expect(resolveEditorScenarioId(paramsOfHref(scenarioEditorHref(UUID)))).toBe(UUID);
  });

  it("resolves a UUID given as ?id=, not only as ?scenario=", () => {
    expect(resolveEditorScenarioId(paramsOf(`?id=${UUID}`))).toBe(UUID);
  });

  it("resolves a legacy numeric ?id= as well", () => {
    expect(resolveEditorScenarioId(paramsOf("?id=42"))).toBe("42");
    expect(resolveEditorScenarioId(paramsOf("?id=0"))).toBe("0");
  });

  it("prefers ?scenario= when both parameters are present", () => {
    expect(resolveEditorScenarioId(paramsOf(`?id=42&scenario=${UUID}`))).toBe(UUID);
    expect(resolveEditorScenarioId(paramsOf(`?scenario=${UUID}&id=42`))).toBe(UUID);
  });

  it("falls back to ?id= when ?scenario= carries no value", () => {
    expect(resolveEditorScenarioId(paramsOf(`?scenario=&id=${UUID}`))).toBe(UUID);
  });

  it("resolves nothing when no usable parameter is present", () => {
    expect(resolveEditorScenarioId(paramsOf(""))).toBeNull();
    expect(resolveEditorScenarioId(paramsOf("?id="))).toBeNull();
    expect(resolveEditorScenarioId(paramsOf("?id=%20"))).toBeNull();
    expect(resolveEditorScenarioId(paramsOf("?scenario=%20"))).toBeNull();
    expect(resolveEditorScenarioId(paramsOf("?import=true"))).toBeNull();
  });

  it("escapes the id it writes, so the resolved value round-trips", () => {
    const id = "a b&c";
    expect(scenarioEditorHref(id)).toBe("/editor?scenario=a%20b%26c");
    expect(resolveEditorScenarioId(paramsOfHref(scenarioEditorHref(id)))).toBe(id);
  });
});

describe("editor route run parameter", () => {
  it("resolves the run the executions page sends", () => {
    expect(resolveEditorRunId(paramsOf("?runId=run-1"))).toBe("run-1");
  });

  it("resolves the run its own run link writes, escaping what needs it", () => {
    expect(resolveEditorRunId(paramsOfHref(runEditorHref("run 1&2")))).toBe("run 1&2");
  });

  it("keeps the run and the scenario of one URL independent", () => {
    const params = paramsOf(`?scenario=${UUID}&runId=run-1`);
    expect(resolveEditorScenarioId(params)).toBe(UUID);
    expect(resolveEditorRunId(params)).toBe("run-1");
  });

  it("resolves nothing when the URL names no run", () => {
    expect(resolveEditorRunId(paramsOf(""))).toBeNull();
    expect(resolveEditorRunId(paramsOf("?runId="))).toBeNull();
    expect(resolveEditorRunId(paramsOf("?runId=%20"))).toBeNull();
    expect(resolveEditorRunId(paramsOf(`?scenario=${UUID}`))).toBeNull();
  });
});
