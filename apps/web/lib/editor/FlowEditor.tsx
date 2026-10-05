"use client";

// K6F4-05b: Main editor component with React Flow canvas and node palette.
// State management and scenario persistence handled by the page (05c/06).

import { useCallback, useRef, useMemo, type DragEvent } from "react";
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
  nodes: K6NodeType[];
  edges: K6Edge[];
  onNodesChange: (nodes: K6NodeType[]) => void;
  onEdgesChange: (edges: K6Edge[]) => void;
  onNodeSelect?: (node: K6NodeType | null) => void;
  readOnly?: boolean;
}

export function FlowEditor({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  onNodeSelect,
  readOnly = false,
}: FlowEditorProps) {
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const reactFlowInstance = useRef<ReactFlowInstance | null>(null);

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
      } else if (selectedNodes.length === 0) {
        onNodeSelect?.(null);
      }
    },
    [onNodeSelect],
  );

  // Handle node changes - controlled mode
  const handleNodesChange = useCallback(
    (changes: NodeChange<Node>[]) => {
      const updatedNodes = applyNodeChanges(changes, nodes as Node[]);
      onNodesChange(updatedNodes as K6NodeType[]);
    },
    [nodes, onNodesChange],
  );

  // Handle edge changes - controlled mode
  const handleEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      const updatedEdges = applyEdgeChanges(changes, edges as Edge[]);
      onEdgesChange(updatedEdges as K6Edge[]);
    },
    [edges, onEdgesChange],
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
      onNodesChange([...nodes, newNode]);
    },
    [nodes, readOnly, onNodesChange],
  );

  const onInit = useCallback((instance: ReactFlowInstance) => {
    reactFlowInstance.current = instance;
  }, []);

  return (
    <div className="flex h-full w-full">
      {!readOnly && <NodePalette />}

      <div ref={reactFlowWrapper} className="flex-1 h-full bg-surface">
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
