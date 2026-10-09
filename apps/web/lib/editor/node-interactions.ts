import { generateNodeId, type K6Node, type K6Edge, type NodeKind } from "./mapping";

export type Reference = { producerNodeId: string; output: string };
export type Clipboard = { flow: string; nodes: K6Node[]; edges: K6Edge[] };
export type GraphResult = { nodes: K6Node[]; edges: K6Edge[]; error?: string };
export type NodeAction = "copy" | "paste" | "duplicate" | "delete" | "toggle";
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const isReference = (value: unknown): value is Reference => {
  const r = object(value);
  return typeof r.producerNodeId === "string" && typeof r.output === "string";
};

/** Schema-slot traversal only: never descend into literal values or manual user data. */
function visitReferences(kind: NodeKind, parameters: unknown, visit: (r: Reference, slot: string) => void) {
  const p = object(parameters);
  const value = (v: unknown, type = "string") => {
    const slot = object(v);
    if (slot.kind === "reference" && isReference(slot.reference)) visit(slot.reference, type);
  };
  const request = (p: ObjectValue) => {
    value(p.url);
    for (const entry of [...array(p.headers), ...array(p.query)]) value(object(entry).value);
    const body = object(p.body);
    if (["text", "json", "xml", "form"].includes(String(body.kind))) {
      value(body.value, body.kind === "json" ? "json" : "string");
    }
  };
  if (kind === "http-request") request(p);
  if (kind === "authentication") {
    const method = object(p.method);
    if (method.kind === "http") request(object(method.request));
  }
  if (kind === "response-validation" && isReference(p.response)) visit(p.response, "http-response");
}

export function embeddedReferences(node: K6Node): Reference[] {
  const refs: Reference[] = [];
  visitReferences(node.data.kind, node.data.parameters, r => refs.push(r));
  return refs;
}

export function parameterReferences(kind: NodeKind, parameters: unknown): Reference[] {
  const refs = new Map<string, Reference>();
  visitReferences(kind, parameters, r => refs.set(JSON.stringify([r.producerNodeId, r.output]), { ...r }));
  return [...refs.values()];
}

function allReferences(node: K6Node) {
  return [...array(node.data.references).filter(isReference), ...embeddedReferences(node)];
}

export function copySelection(nodes: K6Node[], edges: K6Edge[], flow: string): Clipboard | null {
  const selected = nodes.filter(n => n.selected);
  if (!selected.length) return null;
  const ids = new Set(selected.map(n => n.id));
  return structuredClone({ flow, nodes: selected, edges: edges.filter(e => ids.has(e.source) && ids.has(e.target)) });
}

function outputType(node: K6Node | undefined, output: string): string | undefined {
  if (!node) return undefined;
  if (node.data.kind === "http-request") return output === "response" ? "http-response" : undefined;
  if (!["authentication", "user-pool"].includes(node.data.kind)) return undefined;
  const entry = array(object(node.data.parameters).outputs).map(object).find(o => o.name === output);
  return entry ? node.data.kind === "user-pool" ? "string" : String(entry.expectedType) : undefined;
}

/** Even a faulty/repeating ID factory cannot collide or spin indefinitely. */
function freshId(used: Set<string>, factory: () => string): string {
  const base = factory();
  let id = base;
  let suffix = 0;
  while (used.has(id)) id = `${base}-${++suffix}`;
  used.add(id);
  return id;
}

export function pasteClipboard(
  nodes: K6Node[], edges: K6Edge[], clipboard: Clipboard | null, flow: string,
  factory: () => string = generateNodeId, offset = { x: 30, y: 30 },
): GraphResult {
  const refuse = (error: string): GraphResult => ({ nodes, edges, error });
  if (!clipboard) return refuse("No hay nodos copiados.");
  if (clipboard.flow !== flow) return refuse("El portapapeles pertenece a otro flujo. Copia los nodos de nuevo.");
  const copiedIds = new Set(clipboard.nodes.map(n => n.id));
  const producers = new Map(nodes.map(n => [n.id, n]));
  // Internal producers come from the immutable snapshot, external producers from the live graph.
  for (const node of clipboard.nodes) producers.set(node.id, node);
  for (const node of clipboard.nodes) {
    for (const r of allReferences(node)) {
      if (outputType(producers.get(r.producerNodeId), r.output) === undefined) {
        return refuse(`No se puede pegar: la referencia a ${r.producerNodeId}.${r.output} ya no es válida.`);
      }
    }
    let incompatible = false;
    visitReferences(node.data.kind, node.data.parameters, (r, slot) => {
      const type = outputType(producers.get(r.producerNodeId), r.output);
      // Match composition: strings are JSON data, but JSON need not be a string.
      if (type !== slot && !(slot === "json" && type === "string")) incompatible = true;
    });
    if (incompatible) return refuse("No se puede pegar: una referencia tiene un tipo de salida incompatible.");
  }
  const used = new Set([...nodes, ...edges, ...clipboard.nodes, ...clipboard.edges].map(n => n.id));
  const ids = new Map([...copiedIds].map(id => [id, freshId(used, factory)]));
  const remap = (r: Reference) => { r.producerNodeId = ids.get(r.producerNodeId) ?? r.producerNodeId; };
  const copies = structuredClone(clipboard.nodes).map(node => {
    for (const r of array(node.data.references).filter(isReference)) remap(r);
    visitReferences(node.data.kind, node.data.parameters, remap);
    return { ...node, id: ids.get(node.id)!, selected: true, dragging: false,
      position: { x: node.position.x + offset.x, y: node.position.y + offset.y } };
  });
  const connections = structuredClone(clipboard.edges).map(edge => ({ ...edge,
    id: freshId(used, factory), source: ids.get(edge.source)!, target: ids.get(edge.target)!, selected: false }));
  return { nodes: [...nodes.map(n => ({ ...n, selected: false })), ...copies],
    edges: [...edges.map(e => ({ ...e, selected: false })), ...connections] };
}

export function deleteSelection(nodes: K6Node[], edges: K6Edge[]): GraphResult {
  const ids = new Set(nodes.filter(n => n.selected).map(n => n.id));
  const consumer = nodes.find(n => !ids.has(n.id) && allReferences(n).some(r => ids.has(r.producerNodeId)));
  if (consumer) return { nodes, edges, error: `No se puede eliminar: «${consumer.data.label}» mantiene una referencia a los nodos seleccionados. Elimina primero esa referencia o selecciona también el consumidor.` };
  return { nodes: nodes.filter(n => !ids.has(n.id)), edges: edges.filter(e => !ids.has(e.source) && !ids.has(e.target)) };
}

export function renameNode(nodes: K6Node[], id: string, name: string): { nodes: K6Node[]; error?: string } {
  const label = name.trim();
  if (!label || label.length > 120) return { nodes, error: "El nombre debe tener entre 1 y 120 caracteres y no puede estar vacío." };
  return { nodes: nodes.map(n => n.id === id ? { ...n, data: { ...n.data, label } } : n) };
}

export function toggleDisabled(nodes: K6Node[], ids: string[]): K6Node[] {
  const selected = new Set(ids);
  return nodes.map(n => selected.has(n.id) ? { ...n, data: { ...n.data, disabled: !n.data.disabled } } : n);
}

type ShortcutEvent = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing" | "keyCode">;
export function shortcutAction(event: ShortcutEvent, editing: boolean, readOnly: boolean): NodeAction | null {
  if (readOnly || editing || event.isComposing || event.keyCode === 229 || event.altKey || event.shiftKey) return null;
  if (event.ctrlKey || event.metaKey) {
    return ({ c: "copy", v: "paste", d: "duplicate" } as const)[event.key.toLowerCase() as "c" | "v" | "d"] ?? null;
  }
  return event.key === "Delete" || event.key === "Backspace" ? "delete" : null;
}

export function isEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), .monaco-editor, .cm-editor, .CodeMirror, [role="textbox"]');
}
