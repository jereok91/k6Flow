/**
 * Run ownership tracking for the orchestrator proxy.
 * 
 * This is a simple in-memory store mapping runId -> userId.
 * In production, this should be persisted to the database.
 * 
 * WARNING: This store is cleared on server restart. For production,
 * implement proper run ownership in the database or orchestrator.
 */

// Map of runId -> userId
const runOwnership = new Map<string, string>();

export function setRunOwner(runId: string, userId: string): void {
  runOwnership.set(runId, userId);
}

export function getRunOwner(runId: string): string | undefined {
  return runOwnership.get(runId);
}

export function isRunOwner(runId: string, userId: string): boolean {
  const owner = runOwnership.get(runId);
  return owner === userId;
}

export function clearRunOwner(runId: string): void {
  runOwnership.delete(runId);
}
