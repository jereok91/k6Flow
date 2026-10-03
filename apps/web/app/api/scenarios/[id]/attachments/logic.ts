/**
 * K6F6-02: Attachments API logic.
 */

import { eq, and } from "drizzle-orm";
import type { Db } from "../../../../../lib/db/client";
import { attachments, scenarios, type Attachment, type NewAttachment } from "../../../../../lib/db/schema";

const MAX_FILE_SIZE = 1024 * 1024; // 1MB
const ALLOWED_CONTENT_TYPES = ["text/csv", "application/csv", "text/plain"];

export interface AttachmentUpload {
  name: string;
  contentType: string;
  data: string; // base64 encoded
}

export interface AttachmentInfo {
  id: string;
  name: string;
  contentType: string;
  size: number;
  createdAt: Date;
}

export type AttachmentsResult =
  | { ok: true; attachments: AttachmentInfo[] }
  | { ok: false; error: string; status: 400 | 404 | 413 };

export type AttachmentCreateResult =
  | { ok: true; attachment: AttachmentInfo }
  | { ok: false; error: string; status: 400 | 404 | 413 };

export type AttachmentDeleteResult =
  | { ok: true }
  | { ok: false; error: string; status: 404 };

function toAttachmentInfo(a: Attachment): AttachmentInfo {
  return {
    id: a.id,
    name: a.name,
    contentType: a.contentType,
    size: a.size,
    createdAt: a.createdAt,
  };
}

/**
 * List attachments for a scenario.
 */
export async function listAttachments(
  db: Db,
  scenarioId: string,
  userId: string,
): Promise<AttachmentsResult> {
  // Verify scenario ownership
  const scenario = await db
    .select({ id: scenarios.id })
    .from(scenarios)
    .where(and(eq(scenarios.id, scenarioId), eq(scenarios.ownerId, userId)))
    .limit(1);

  if (scenario.length === 0) {
    return { ok: false, error: "Scenario not found", status: 404 };
  }

  const rows = await db
    .select()
    .from(attachments)
    .where(eq(attachments.scenarioId, scenarioId));

  return { ok: true, attachments: rows.map(toAttachmentInfo) };
}

/**
 * Upload a new attachment.
 */
export async function createAttachment(
  db: Db,
  scenarioId: string,
  userId: string,
  upload: AttachmentUpload,
): Promise<AttachmentCreateResult> {
  // Verify scenario ownership
  const scenario = await db
    .select({ id: scenarios.id })
    .from(scenarios)
    .where(and(eq(scenarios.id, scenarioId), eq(scenarios.ownerId, userId)))
    .limit(1);

  if (scenario.length === 0) {
    return { ok: false, error: "Scenario not found", status: 404 };
  }

  // Validate content type
  if (!ALLOWED_CONTENT_TYPES.includes(upload.contentType)) {
    return { ok: false, error: "Invalid content type. Only CSV files allowed.", status: 400 };
  }

  // Validate name
  if (!upload.name || upload.name.trim().length === 0) {
    return { ok: false, error: "File name is required", status: 400 };
  }

  // Decode and validate size
  let decoded: Buffer;
  try {
    decoded = Buffer.from(upload.data, "base64");
  } catch {
    return { ok: false, error: "Invalid base64 data", status: 400 };
  }

  if (decoded.length > MAX_FILE_SIZE) {
    return { ok: false, error: `File too large. Maximum size is ${MAX_FILE_SIZE} bytes.`, status: 413 };
  }

  // Generate ID
  const id = crypto.randomUUID();

  const newAttachment: NewAttachment = {
    id,
    scenarioId,
    name: upload.name.trim(),
    contentType: upload.contentType,
    size: decoded.length,
    data: upload.data,
  };

  const [inserted] = await db.insert(attachments).values(newAttachment).returning();

  return { ok: true, attachment: toAttachmentInfo(inserted) };
}

/**
 * Delete an attachment.
 */
export async function deleteAttachment(
  db: Db,
  scenarioId: string,
  attachmentId: string,
  userId: string,
): Promise<AttachmentDeleteResult> {
  // Verify scenario ownership
  const scenario = await db
    .select({ id: scenarios.id })
    .from(scenarios)
    .where(and(eq(scenarios.id, scenarioId), eq(scenarios.ownerId, userId)))
    .limit(1);

  if (scenario.length === 0) {
    return { ok: false, error: "Scenario not found", status: 404 };
  }

  const deleted = await db
    .delete(attachments)
    .where(and(eq(attachments.id, attachmentId), eq(attachments.scenarioId, scenarioId)))
    .returning({ id: attachments.id });

  if (deleted.length === 0) {
    return { ok: false, error: "Attachment not found", status: 404 };
  }

  return { ok: true };
}

/**
 * Get attachment with data (for download/execution).
 */
export async function getAttachmentWithData(
  db: Db,
  scenarioId: string,
  attachmentId: string,
  userId: string,
): Promise<{ ok: true; attachment: Attachment } | { ok: false; error: string; status: 404 }> {
  // Verify scenario ownership
  const scenario = await db
    .select({ id: scenarios.id })
    .from(scenarios)
    .where(and(eq(scenarios.id, scenarioId), eq(scenarios.ownerId, userId)))
    .limit(1);

  if (scenario.length === 0) {
    return { ok: false, error: "Scenario not found", status: 404 };
  }

  const rows = await db
    .select()
    .from(attachments)
    .where(and(eq(attachments.id, attachmentId), eq(attachments.scenarioId, scenarioId)))
    .limit(1);

  if (rows.length === 0) {
    return { ok: false, error: "Attachment not found", status: 404 };
  }

  return { ok: true, attachment: rows[0] };
}
