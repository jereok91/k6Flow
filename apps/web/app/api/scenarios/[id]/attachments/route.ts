/**
 * K6F6-02: Attachments API routes.
 * GET /api/scenarios/:id/attachments - list attachments
 * POST /api/scenarios/:id/attachments - upload attachment
 */

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "../../../../../lib/db/client";
import { requireUser } from "../../../../../lib/auth/require-user";
import { listAttachments, createAttachment, type AttachmentUpload } from "./logic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const cookieHeader = request.headers.get("cookie");
  const user = await requireUser(cookieHeader);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: scenarioId } = await params;
  const db = getDb();
  const result = await listAttachments(db, scenarioId, user.id);

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({ attachments: result.attachments });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const cookieHeader = request.headers.get("cookie");
  const user = await requireUser(cookieHeader);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: scenarioId } = await params;

  let body: AttachmentUpload;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.name || !body.contentType || !body.data) {
    return NextResponse.json(
      { error: "Missing required fields: name, contentType, data" },
      { status: 400 },
    );
  }

  const db = getDb();
  const result = await createAttachment(db, scenarioId, user.id, body);

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({ attachment: result.attachment }, { status: 201 });
}
