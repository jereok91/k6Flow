// K6F4-05b: Editor module exports.

export { FlowEditor } from "./FlowEditor";
export { K6Node } from "./K6Node";
export { NodePalette } from "./NodePalette";
export {
  toReactFlowGraph,
  fromReactFlowGraph,
  createNode,
  generateNodeId,
  resetNodeIdCounter,
  generateEdgeId,
  getNodeLabel,
  NODE_KINDS,
  type K6Node as K6NodeType,
  type K6Edge,
  type K6NodeData,
  type NodeKind,
} from "./mapping";
