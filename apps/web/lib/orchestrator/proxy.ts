/**
 * Shared orchestrator proxy config. Reads env at call time so tests and
 * runtime config changes are honoured; defaults match the in-cluster
 * Docker setup (see app/api/orchestrator/runs/[runId]/route.ts).
 */

export function orchestratorBaseUrl(): string {
  return process.env.ORCHESTRATOR_INTERNAL_URL ?? "http://orchestrator:8080";
}

export function orchestratorAuthHeaders(): Record<string, string> {
  const token = process.env.ORCHESTRATOR_SERVICE_TOKEN ?? "k6flow-internal-token";
  return { Authorization: `Bearer ${token}` };
}
