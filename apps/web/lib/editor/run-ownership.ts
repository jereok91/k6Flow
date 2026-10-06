/**
 * Run ownership tracking for the orchestrator proxy.
 * 
 * This module persists run ownership in the database, surviving
 * server restarts and working across multiple replicas.
 */

import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { runOwnership } from "../db/schema";

export async function setRunOwner(runId: string, userId: string): Promise<void> {
  const db = getDb();
  await db
    .insert(runOwnership)
    .values({ runId, userId })
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
