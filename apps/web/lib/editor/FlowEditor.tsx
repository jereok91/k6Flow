"use client";

// K6F4-05b: Main editor component with React Flow canvas and node palette.
// State management and scenario persistence handled by the page (05c/06).

import { useCallback, useRef, useMemo, useState, type DragEvent } from "react";
import { useNodeInteractions } from "./use-node-interactions";
import { NodeContextMenu } from "./NodeContextMenu";
import { isEditingTarget, shortcutAction } from "./node-interactions";
import {
  ReactFlow,
  Controls,
  Background,
  applyNodeChanges,
  applyEdgeChanges,
  type Connection,
  type ReactFlowInstance,
  type NodeTypes,
  type Node,
  type Edge,
  type OnSelectionChangeFunc,
  type NodeChange,
  type EdgeChange,
  type ColorMode,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { K6Node } from "./K6Node";
import { NodePalette } from "./NodePalette";
import { useTheme } from "../theme";
import {
  createNode,
  generateEdgeId,
  type K6Node as K6NodeType,
  type K6Edge,
  type NodeKind,
} from "./mapping";

interface FlowEditorProps {
  nodes: K6NodeType[];
  edges: K6Edge[];
  onNodesChange: (nodes: K6NodeType[]) => void;
  onEdgesChange: (edges: K6Edge[]) => void;
  onNodeSelect?: (node: K6NodeType | null) => void;
  readOnly?: boolean;
  /** Changes whenever the page replaces the graph, even when node IDs are reused. */
  flowSession: string;
  /** Notified once with the removed ids when an accepted change actually deletes nodes. */
  onNodesRemoved?: (nodeIds: readonly string[]) => void;
}

/** Ids present in `previous` but absent from `next`, in graph order; empty when nothing was removed. */
export function removedNodeIds(
  previous: readonly K6NodeType[],
  next: readonly K6NodeType[],
): string[] {
  const nextIds = new Set(next.map(node => node.id));
  return previous.filter(node => !nextIds.has(node.id)).map(node => node.id);
}

/** Notifies once with the removed ids when an accepted node change removed nodes; a no-op otherwise. */
export function notifyNodesRemoved(
  previous: readonly K6NodeType[],
  next: readonly K6NodeType[],
  onNodesRemoved?: (nodeIds: readonly string[]) => void,
): void {
  if (!onNodesRemoved) return;
  const removed = removedNodeIds(previous, next);
  if (removed.length > 0) onNodesRemoved(removed);
}

export function FlowEditor({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  onNodeSelect,
  readOnly = false,
  flowSession,
  onNodesRemoved,
}: FlowEditorProps) {
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const reactFlowInstance = useRef<ReactFlowInstance | null>(null);
  const { theme } = useTheme();
  const colorMode: ColorMode = theme === "dark" ? "dark" : "light";
  // Single acceptance point for node changes: report a real removal before the
  // page replaces the graph. A refused deletion never reaches here with fewer nodes.
  const commitNodes = useCallback(
    (next: K6NodeType[]) => {
      notifyNodesRemoved(nodes, next, onNodesRemoved);
      onNodesChange(next);
    },
    [nodes, onNodesChange, onNodesRemoved],
  );
  const interactions = useNodeInteractions({ nodes, edges, flow: flowSession, readOnly,
    onNodesChange: commitNodes, onEdgesChange, onNodeSelect });
  const [menu, setMenu] = useState<{ x: number; y: number; ids: string[] } | null>(null);
  const closeMenu = useCallback(() => {
    setMenu(null);
    reactFlowWrapper.current?.focus();
  }, []);

  // Memoize nodeTypes to prevent re-renders
  const nodeTypes: NodeTypes = useMemo(
    () => ({
      k6Node: K6Node,
    }),
    [],
  );

  // Handle selection changes
  const handleSelectionChange: OnSelectionChangeFunc = useCallback(
    ({ nodes: selectedNodes }) => {
      if (selectedNodes.length === 1) {
        onNodeSelect?.(selectedNodes[0] as K6NodeType);
      } else {
        onNodeSelect?.(null);
      }
    },
    [onNodeSelect],
  );

  // Handle node changes - controlled mode
  const handleNodesChange = useCallback(
    (changes: NodeChange<Node>[]) => {
      if (readOnly) return;
      // Removal must go through reference-safe deleteSelection, never React Flow's built-in path.
      const updatedNodes = applyNodeChanges(changes.filter(c => c.type !== "remove"), nodes as Node[]);
      commitNodes(updatedNodes as K6NodeType[]);
    },
    [nodes, commitNodes, readOnly],
  );

  // Handle edge changes - controlled mode
  const handleEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      if (readOnly) return;
      const updatedEdges = applyEdgeChanges(changes, edges as Edge[]);
      onEdgesChange(updatedEdges as K6Edge[]);
    },
    [edges, onEdgesChange, readOnly],
  );

  // Handle new connections
  const onConnect = useCallback(
    (connection: Connection) => {
      if (readOnly) return;
      if (!connection.source || !connection.target) return;
      const newEdge: Edge = {
        id: generateEdgeId(connection.source, connection.target),
        source: connection.source,
        target: connection.target,
        sourceHandle: connection.sourceHandle ?? null,
        targetHandle: connection.targetHandle ?? null,
      };
      onEdgesChange([...edges, newEdge] as K6Edge[]);
    },
    [edges, readOnly, onEdgesChange],
  );

  // Handle drag over (allow drop)
  const onDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  // Handle drop (add new node)
  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();

      if (readOnly) return;

      const kind = event.dataTransfer.getData("application/k6flow-node-kind") as NodeKind;
      if (!kind) return;

      const reactFlowBounds = reactFlowWrapper.current?.getBoundingClientRect();
      if (!reactFlowBounds || !reactFlowInstance.current) return;

      const position = reactFlowInstance.current.screenToFlowPosition({
        x: event.clientX - reactFlowBounds.left,
        y: event.clientY - reactFlowBounds.top,
      });

      const newNode = createNode(kind, position);
      commitNodes([...nodes, newNode]);
    },
    [nodes, readOnly, commitNodes],
  );

  const onInit = useCallback((instance: ReactFlowInstance) => {
    reactFlowInstance.current = instance;
  }, []);

  return (
    <div className="flex h-full w-full">
      {!readOnly && <NodePalette />}

      <div ref={reactFlowWrapper} tabIndex={0} aria-label="Lienzo del flujo"
        onPointerDown={event => {
          if (!isEditingTarget(event.target)) reactFlowWrapper.current?.focus({ preventScroll: true });
        }}
        onKeyDown={event => {
          const action = shortcutAction(event.nativeEvent, isEditingTarget(event.target), readOnly);
          if (!action) return;
          event.preventDefault(); event.stopPropagation();
          interactions.execute(action, menu?.ids);
          closeMenu();
        }}
        style={{ flex: 1, height: "100%", background: "var(--color-surface)" }}>
        <ReactFlow
          nodes={nodes as Node[]}
          edges={edges as Edge[]}
          onNodesChange={handleNodesChange}
          onEdgesChange={handleEdgesChange}
          onConnect={onConnect}
          onInit={onInit}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onSelectionChange={handleSelectionChange}
          deleteKeyCode={null}
          multiSelectionKeyCode={["Control", "Meta", "Shift"]}
          onNodeContextMenu={(event, node) => {
            event.preventDefault();
            if (readOnly) return;
            const selected = node.selected ? nodes.filter(n => n.selected) : [node as K6NodeType];
            const ids = selected.map(n => n.id);
            onNodesChange(nodes.map(n => ({ ...n, selected: ids.includes(n.id) })));
            onNodeSelect?.(selected.length === 1 ? selected[0] : null);
            setMenu({ x: event.clientX, y: event.clientY, ids });
          }}
          onPaneContextMenu={event => {
            event.preventDefault();
            if (readOnly) return;
            setMenu({ x: event.clientX, y: event.clientY, ids: nodes.filter(n => n.selected).map(n => n.id) });
          }}
          onPaneClick={() => setMenu(null)}
          nodeTypes={nodeTypes}
          colorMode={colorMode}
          fitView
          snapToGrid
          snapGrid={[15, 15]}
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          elementsSelectable={!readOnly}
          style={{ background: "var(--color-surface)", width: "100%", height: "100%" }}
        >
          <Controls 
            showInteractive={!readOnly}
            style={{
              background: "var(--color-surface-container-low)",
              border: "1px solid var(--color-surface-container-high)",
              borderRadius: "0.5rem",
            }}
          />
          <Background 
            gap={15} 
            size={1} 
            color="var(--color-surface-container-high)"
          />
        </ReactFlow>
        {interactions.message && <div role="status" aria-live="polite"
          style={{ position: "absolute", left: 240, bottom: 16, maxWidth: "60%", padding: "8px 12px",
            borderRadius: 8, background: "var(--color-surface-container-low)", color: "var(--color-on-surface)", zIndex: 20 }}>
          {interactions.message}
        </div>}
        {menu && !readOnly && <NodeContextMenu x={menu.x} y={menu.y} hasNodes={menu.ids.length > 0}
          canPaste={!!interactions.canPaste} onClose={closeMenu} onAction={action => {
            interactions.execute(action, menu.ids);
            closeMenu();
          }} />}
      </div>
    </div>
  );
}
