/**
 * Run ownership and history tracking for the orchestrator proxy.
 * 
 * This module persists run ownership in the database, surviving
 * server restarts and working across multiple replicas.
 */

import { eq, desc } from "drizzle-orm";
import { getDb } from "../db/client";
import { runOwnership, type RunOwnership } from "../db/schema";

export interface RunHistoryData {
  scenarioId?: string;
  scenarioName?: string;
  vus?: number;
  durationMs?: number;
}

export async function setRunOwner(
  runId: string,
  userId: string,
  data?: RunHistoryData
): Promise<void> {
  const db = getDb();
  await db
    .insert(runOwnership)
    .values({
      runId,
      userId,
      scenarioId: data?.scenarioId,
      scenarioName: data?.scenarioName,
      vus: data?.vus,
      durationMs: data?.durationMs,
      status: "running",
    })
    .onConflictDoUpdate({
      target: runOwnership.runId,
      set: { userId },
    });
}

export async function getRunOwner(runId: string): Promise<string | undefined> {
  const db = getDb();
  const result = await db
    .select({ userId: runOwnership.userId })
    .from(runOwnership)
    .where(eq(runOwnership.runId, runId))
    .limit(1);
  return result[0]?.userId;
}

export async function isRunOwner(runId: string, userId: string): Promise<boolean> {
  const owner = await getRunOwner(runId);
  return owner === userId;
}

export async function clearRunOwner(runId: string): Promise<void> {
  const db = getDb();
  await db.delete(runOwnership).where(eq(runOwnership.runId, runId));
}

export interface RunUpdateData {
  status: "running" | "completed" | "failed" | "stopped";
  iterations?: number;
  avgDurationMs?: number;
  errorRate?: number; // percentage, e.g., 5.5
}

export async function updateRunStatus(
  runId: string,
  data: RunUpdateData
): Promise<void> {
  const db = getDb();
  await db
    .update(runOwnership)
    .set({
      status: data.status,
      iterations: data.iterations,
      avgDurationMs: data.avgDurationMs ? Math.round(data.avgDurationMs) : undefined,
      errorRate: data.errorRate !== undefined ? Math.round(data.errorRate * 100) : undefined,
      completedAt: data.status !== "running" ? new Date() : undefined,
    })
    .where(eq(runOwnership.runId, runId));
}

export async function getUserRunHistory(
  userId: string,
  limit = 50
): Promise<RunOwnership[]> {
  const db = getDb();
  return db
    .select()
    .from(runOwnership)
    .where(eq(runOwnership.userId, userId))
    .orderBy(desc(runOwnership.createdAt))
    .limit(limit);
}

export async function getScenarioRunHistory(
  scenarioId: string,
  userId: string,
  limit = 20
): Promise<RunOwnership[]> {
  const db = getDb();
  // Using raw SQL for AND condition
  return db
    .select()
    .from(runOwnership)
    .where(eq(runOwnership.scenarioId, scenarioId))
    .orderBy(desc(runOwnership.createdAt))
    .limit(limit);
}
