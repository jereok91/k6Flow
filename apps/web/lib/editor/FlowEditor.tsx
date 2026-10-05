"use client";

// K6F4-05b: Main editor component with React Flow canvas and node palette.
// State management and scenario persistence handled by the page (05c/06).

import { useCallback, useRef, useMemo, useEffect, type DragEvent } from "react";
import {
  ReactFlow,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  useOnSelectionChange,
  type Connection,
  type ReactFlowInstance,
  type NodeTypes,
  type Node,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { K6Node } from "./K6Node";
import { NodePalette } from "./NodePalette";
import {
  createNode,
  generateEdgeId,
  type K6Node as K6NodeType,
  type K6Edge,
  type NodeKind,
} from "./mapping";

interface FlowEditorProps {
  initialNodes?: K6NodeType[];
  initialEdges?: K6Edge[];
  onNodesChange?: (nodes: K6NodeType[]) => void;
  onEdgesChange?: (edges: K6Edge[]) => void;
  onNodeSelect?: (node: K6NodeType | null) => void;
  readOnly?: boolean;
}

export function FlowEditor({
  initialNodes = [],
  initialEdges = [],
  onNodesChange,
  onEdgesChange,
  onNodeSelect,
  readOnly = false,
}: FlowEditorProps) {
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const [nodes, setNodes, onNodesChangeInternal] = useNodesState(initialNodes as Node[]);
  const [edges, setEdges, onEdgesChangeInternal] = useEdgesState(initialEdges as Edge[]);
  const reactFlowInstance = useRef<ReactFlowInstance | null>(null);

  // Sync with external state when initialNodes change
  useEffect(() => {
    setNodes(initialNodes as Node[]);
  }, [initialNodes, setNodes]);

  useEffect(() => {
    setEdges(initialEdges as Edge[]);
  }, [initialEdges, setEdges]);

  // Memoize nodeTypes to prevent re-renders
  const nodeTypes: NodeTypes = useMemo(
    () => ({
      k6Node: K6Node,
    }),
    [],
  );

  // Handle selection changes
  useOnSelectionChange({
    onChange: ({ nodes: selectedNodes }) => {
      if (selectedNodes.length === 1) {
        onNodeSelect?.(selectedNodes[0] as K6NodeType);
      } else if (selectedNodes.length === 0) {
        onNodeSelect?.(null);
      }
    },
  });

  // Notify parent of node changes
  const handleNodesChange = useCallback(
    (changes: Parameters<typeof onNodesChangeInternal>[0]) => {
      onNodesChangeInternal(changes);
    },
    [onNodesChangeInternal],
  );

  // Sync nodes to parent after internal state updates
  useEffect(() => {
    onNodesChange?.(nodes as K6NodeType[]);
  }, [nodes, onNodesChange]);

  // Sync edges to parent after internal state updates
  useEffect(() => {
    onEdgesChange?.(edges as K6Edge[]);
  }, [edges, onEdgesChange]);

  const handleEdgesChange = useCallback(
    (changes: Parameters<typeof onEdgesChangeInternal>[0]) => {
      onEdgesChangeInternal(changes);
    },
    [onEdgesChangeInternal],
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
      setEdges((eds) => [...eds, newEdge]);
    },
    [setEdges, readOnly],
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
      setNodes((nds) => [...nds, newNode as Node]);
    },
    [setNodes, readOnly],
  );

  const onInit = useCallback((instance: ReactFlowInstance) => {
    reactFlowInstance.current = instance;
  }, []);

  return (
    <div className="flex h-full w-full">
      {!readOnly && <NodePalette />}

      <div ref={reactFlowWrapper} className="flex-1 h-full bg-surface">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={handleNodesChange}
          onEdgesChange={handleEdgesChange}
          onConnect={onConnect}
          onInit={onInit}
          onDragOver={onDragOver}
          onDrop={onDrop}
          nodeTypes={nodeTypes}
          fitView
          snapToGrid
          snapGrid={[15, 15]}
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          elementsSelectable={!readOnly}
          style={{ background: "var(--color-surface)" }}
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
      </div>
    </div>
  );
}
