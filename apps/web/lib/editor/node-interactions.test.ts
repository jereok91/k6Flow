import { describe, expect, it } from "vitest";
import { createNode } from "./mapping";
import { copySelection, pasteClipboard, deleteSelection, renameNode, toggleDisabled, shortcutAction, embeddedReferences, parameterReferences } from "./node-interactions";
import type { K6Node } from "./mapping";

const ref = (id: string, output = "response") => ({ producerNodeId: id, output });
function fixture(): K6Node[] {
  const producer = { ...createNode("http-request", { x: 10, y: 20 }), id: "a", selected: true };
  const consumer = { ...createNode("response-validation", { x: 100, y: 80 }), id: "b", selected: true };
  consumer.data = { ...consumer.data, disabled: true, references: [ref("a")], parameters: { response: ref("a"), checks: [] } };
  return [producer, consumer];
}

describe("node interactions", () => {
  it("deep snapshots only selected nodes and internal edges; copies metadata and remaps both reference forms", () => {
    const nodes = fixture();
    const clipboard = copySelection(nodes, [{ id: "ab", source: "a", target: "b" }, { id: "external", source: "z", target: "a" }], "flow");
    nodes[1].data.label = "changed";
    const result = pasteClipboard(nodes, [], clipboard, "flow", () => "collision");
    expect(result.error).toBeUndefined();
    expect(result.nodes).toHaveLength(4);
    const [a, b] = result.nodes.slice(2);
    expect(new Set(result.nodes.map(n => n.id)).size).toBe(4);
    expect(a.position).toEqual({ x: 40, y: 50 });
    expect(b.position).toEqual({ x: 130, y: 110 });
    expect(b.data.label).toBe("Response Validation");
    expect(b.data.disabled).toBe(true);
    expect(b.data.references).toEqual([ref(a.id)]);
    expect(b.data.parameters).toEqual({ response: ref(a.id), checks: [] });
    expect(result.nodes.slice(0, 2).every(n => !n.selected)).toBe(true);
    expect(result.nodes.slice(2).every(n => n.selected)).toBe(true);
    expect(result.edges).toEqual([expect.objectContaining({ source: a.id, target: b.id })]);
  });

  it("checks node and edge collisions explicitly, including repeated pastes", () => {
    const nodes = fixture();
    const clipboard = copySelection(nodes, [{ id: "ab", source: "a", target: "b" }], "flow");
    const first = pasteClipboard(nodes, [{ id: "a-1", source: "a", target: "b" }], clipboard, "flow", () => "a");
    const second = pasteClipboard(first.nodes, first.edges, clipboard, "flow", () => "a");
    const ids = [...second.nodes, ...second.edges].map(n => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("preserves valid external references but refuses missing or changed outputs and another flow", () => {
    const nodes = fixture(); nodes[0].selected = false;
    const clipboard = copySelection(nodes, [], "flow");
    expect(pasteClipboard(nodes, [], clipboard, "flow").error).toBeUndefined();
    expect(pasteClipboard(nodes.slice(1), [], clipboard, "flow").error).toMatch(/referencia/i);
    expect(pasteClipboard([{ ...nodes[0], data: { ...nodes[0].data, kind: "user-pool" } }, nodes[1]], [], clipboard, "flow").error).toMatch(/referencia/i);
    expect(pasteClipboard(nodes, [], clipboard, "new-flow").error).toMatch(/flujo/i);
  });

  it("remaps supported request slots and HTTP authentication only, never literal lookalikes", () => {
    const r = { kind: "reference", reference: ref("a", "token") };
    const literal = { kind: "literal", value: { kind: "reference", reference: ref("a") } };
    const request = { url: r, headers: [{ value: r }], query: [{ value: r }], body: { kind: "json", value: literal } };
    const nodes = fixture();
    nodes[0].data = { ...nodes[0].data, kind: "authentication", parameters: { method: { kind: "http", request }, outputs: [{ name: "token", expectedType: "string" }] } };
    nodes[1].data = { ...nodes[1].data, kind: "http-request", references: [ref("a", "token")], parameters: request };
    const pasted = pasteClipboard(nodes, [], copySelection(nodes, [], "flow"), "flow");
    const [a, b] = pasted.nodes.slice(2);
    expect(embeddedReferences(b).every(r => r.producerNodeId === a.id)).toBe(true);
    expect((b.data.parameters as typeof request).body.value).toEqual(literal);
    expect((a.data.parameters as { method: { request: typeof request } }).method.request.url.reference.producerNodeId).toBe(a.id);
  });

  it.each(["http-request", "authentication"] as const)("pastes and duplicates JSON outputs into %s JSON bodies while preserving literal JSON", kind => {
    const nodes = fixture();
    nodes[0].data = { ...nodes[0].data, kind: "authentication", parameters: { outputs: [{ name: "payload", expectedType: "json" }] } };
    const literal = { kind: "reference", reference: ref("a", "payload"), nested: [ref("a", "payload")] };
    const request = { body: { kind: "json", value: { kind: "reference", reference: ref("a", "payload") } } };
    nodes[1].data = { ...nodes[1].data, kind, references: [ref("a", "payload")],
      parameters: kind === "authentication" ? { method: { kind: "http", request } } : request };
    const clipboard = copySelection(nodes, [], "flow");
    for (const target of [nodes, []]) {
      const result = pasteClipboard(target, [], clipboard, "flow", () => "copy");
      expect(result.error).toBeUndefined();
      const [producer, consumer] = result.nodes.slice(target.length);
      expect(embeddedReferences(consumer)).toEqual([ref(producer.id, "payload")]);
      expect(consumer.data.references).toEqual([ref(producer.id, "payload")]);
      const copiedRequest = (kind === "authentication"
        ? (consumer.data.parameters as { method: { request: typeof request } }).method.request
        : consumer.data.parameters) as typeof request;
      expect(copiedRequest.body.value.reference).toEqual(ref(producer.id, "payload"));
    }
    const literalRequest = { body: { kind: "json", value: { kind: "literal", value: literal } } };
    nodes[1].data = { ...nodes[1].data, references: [], parameters: kind === "authentication"
      ? { method: { kind: "http", request: literalRequest } } : literalRequest };
    const result = pasteClipboard(nodes, [], copySelection(nodes, [], "flow"), "flow", () => "copy");
    expect(result.error).toBeUndefined();
    expect(result.nodes[3].data.parameters).toEqual(nodes[1].data.parameters);
    expect(embeddedReferences(result.nodes[3])).toEqual([]);
  });

  it.each(["json", "text", "xml", "form"])("refuses incompatible %s body outputs without mutation", kind => {
    const nodes = fixture();
    if (kind !== "json") nodes[0].data = { ...nodes[0].data, kind: "authentication", parameters: {
      outputs: [{ name: "payload", expectedType: "json" }] } };
    const output = kind === "json" ? "response" : "payload";
    nodes[1].data = { ...nodes[1].data, kind: "http-request", references: [ref("a", output)],
      parameters: { body: { kind, value: { kind: "reference", reference: ref("a", output) } } } };
    const before = structuredClone(nodes);
    const result = pasteClipboard(nodes, [], copySelection(nodes, [], "flow"), "flow");
    expect(result.error).toMatch(/incompatible/i);
    expect(result.nodes).toBe(nodes);
    expect(nodes).toEqual(before);
  });

  it("refuses deletion of referenced producers without mutating config; group deletion is allowed", () => {
    const nodes = fixture(); nodes[1].selected = false;
    const before = structuredClone(nodes);
    expect(deleteSelection(nodes, []).error).toMatch(/referencia/i);
    expect(nodes).toEqual(before);
    nodes[1].selected = true;
    expect(deleteSelection(nodes, [{ id: "ab", source: "a", target: "b" }])).toEqual({ nodes: [], edges: [] });
  });

  it("protects embedded references even if not declared, ignores literal lookalikes", () => {
    const nodes = fixture(); nodes[1].selected = false; nodes[1].data.references = [];
    expect(deleteSelection(nodes, []).error).toBeTruthy();
    nodes[1].data.kind = "http-request";
    nodes[1].data.parameters = { url: { kind: "literal", value: { reference: ref("a") } } };
    expect(deleteSelection(nodes, []).nodes).toHaveLength(1);
  });

  it("trims nonblank names up to 120 characters and toggles disabled without losing config", () => {
    const nodes = fixture();
    expect(renameNode(nodes, "a", "  Nuevo  ").nodes[0].data.label).toBe("Nuevo");
    expect(renameNode(nodes, "a", "   ").error).toMatch(/nombre/i);
    expect(renameNode(nodes, "a", "x".repeat(121)).error).toMatch(/120/);
    expect(renameNode(nodes, "a", "x".repeat(120)).error).toBeUndefined();
    const updated = toggleDisabled(nodes, ["b"]);
    expect(updated[1].data).toEqual({ ...nodes[1].data, disabled: false });
  });

  it("reconciles canonical validation, authentication and query references with deduplication", () => {
    const r = { kind: "reference", reference: ref("pool", "token") };
    const request = { url: r, headers: [{ value: r }], query: [{ value: r }], body: { kind: "text", value: r } };
    expect(parameterReferences("http-request", request)).toEqual([ref("pool", "token")]);
    expect(parameterReferences("authentication", { method: { kind: "http", request } })).toEqual([ref("pool", "token")]);
    expect(parameterReferences("authentication", { method: { kind: "static", value: r } })).toEqual([]);
    expect(parameterReferences("response-validation", { response: ref("request") })).toEqual([ref("request")]);
    expect(parameterReferences("user-pool", { manualUsers: [{ value: r }] })).toEqual([]);
  });

  it("remaps reference body slots without descending into payloads", () => {
    for (const kind of ["text", "json", "xml", "form"]) {
      const nodes = fixture();
      nodes[0].data = { ...nodes[0].data, kind: "user-pool", parameters: { outputs: [{ name: "token" }] } };
      nodes[1].data = { ...nodes[1].data, kind: "http-request", references: [ref("a", "token")],
        parameters: { body: { kind, value: { kind: "reference", reference: ref("a", "token") } } } };
      const result = pasteClipboard(nodes, [], copySelection(nodes, [], "flow"), "flow");
      expect(result.error).toBeUndefined();
      expect(embeddedReferences(result.nodes[3])).toEqual([ref(result.nodes[2].id, "token")]);
      expect(embeddedReferences(nodes[1])).toEqual([ref("a", "token")]);
    }
  });

  it("refuses externally changed output types and output names without any graph mutation", () => {
    const nodes = fixture(); nodes[0].selected = false;
    nodes[0].data = { ...nodes[0].data, kind: "authentication", parameters: { outputs: [{ name: "token", expectedType: "string" }] } };
    nodes[1].data = { ...nodes[1].data, kind: "http-request", references: [],
      parameters: { url: { kind: "reference", reference: ref("a", "token") } } };
    const clipboard = copySelection(nodes, [], "flow");
    expect(pasteClipboard(nodes, [], clipboard, "flow").error).toBeUndefined();
    for (const outputs of [[{ name: "token", expectedType: "json" }], [{ name: "different", expectedType: "string" }]]) {
      const live = [{ ...nodes[0], data: { ...nodes[0].data, parameters: { outputs } } }, nodes[1]];
      const before = structuredClone(live);
      const result = pasteClipboard(live, [], clipboard, "flow");
      expect(result.error).toMatch(/referencia/i);
      expect(result.nodes).toBe(live);
      expect(live).toEqual(before);
    }
  });

  it("empty selection does not copy or delete unrelated edges", () => {
    const nodes = fixture().map(n => ({ ...n, selected: false }));
    const edges = [{ id: "ab", source: "a", target: "b", selected: true }];
    expect(copySelection(nodes, edges, "flow")).toBeNull();
    expect(deleteSelection(nodes, edges)).toEqual({ nodes, edges });
    expect(pasteClipboard(nodes, edges, null, "flow")).toEqual({ nodes, edges, error: "No hay nodos copiados." });
  });

  it("rejects stale clipboard after graph replacement even when IDs are identical", () => {
    const nodes = fixture();
    const clipboard = copySelection(nodes, [], "before-load");
    const result = pasteClipboard(structuredClone(nodes), [], clipboard, "after-load");
    expect(result.error).toMatch(/flujo/i);
    expect(result.nodes).toHaveLength(2);
  });

  it("handles canvas shortcuts only with editing, composition and readOnly guards", () => {
    const event = { key: "c", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, isComposing: false, keyCode: 67 };
    expect(shortcutAction(event, false, false)).toBe("copy");
    expect(shortcutAction({ ...event, key: "v", ctrlKey: false, metaKey: true }, false, false)).toBe("paste");
    expect(shortcutAction({ ...event, key: "d" }, false, false)).toBe("duplicate");
    for (const key of ["Delete", "Backspace"]) expect(shortcutAction({ ...event, key, ctrlKey: false }, false, false)).toBe("delete");
    expect(shortcutAction(event, true, false)).toBeNull();
    expect(shortcutAction(event, false, true)).toBeNull();
    expect(shortcutAction({ ...event, isComposing: true }, false, false)).toBeNull();
    expect(shortcutAction({ ...event, keyCode: 229 }, false, false)).toBeNull();
    expect(shortcutAction({ ...event, altKey: true }, false, false)).toBeNull();
    expect(shortcutAction({ ...event, shiftKey: true }, false, false)).toBeNull();
    expect(shortcutAction({ ...event, key: "Delete" }, false, false)).toBeNull();
    expect(shortcutAction({ ...event, key: "C" }, false, false)).toBe("copy");
    expect(shortcutAction({ ...event, key: "c", ctrlKey: false }, false, false)).toBeNull();
  });
});
