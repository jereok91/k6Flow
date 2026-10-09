import { fromReactFlowGraph, type K6Node, type K6Edge } from "./mapping";

export function durationSeconds(duration: string): number {
  const minutes = duration.match(/(\d+)m/);
  const seconds = duration.match(/(\d+)s/);
  return ((minutes ? Number(minutes[1]) * 60 : 0) + (seconds ? Number(seconds[1]) : 0)
    || (/^\d+$/.test(duration) ? Number(duration) : 0)) || 30;
}

export function snapshot(name: string, nodes: K6Node[], edges: K6Edge[], vus: number, duration: string): string {
  return JSON.stringify({ name, graph: fromReactFlowGraph(nodes, edges), vus, durationSeconds: durationSeconds(duration) });
}

export class SaveBaseline {
  private generation = 0;
  constructor(private baseline: string) {}
  reset(value: string) { this.generation++; this.baseline = value; }
  submit(value: string) { return { generation: this.generation, value }; }
  accept(ticket: ReturnType<SaveBaseline["submit"]>): boolean {
    if (ticket.generation !== this.generation) return false;
    this.baseline = ticket.value;
    return true;
  }
  dirty(value: string) { return value !== this.baseline; }
}
