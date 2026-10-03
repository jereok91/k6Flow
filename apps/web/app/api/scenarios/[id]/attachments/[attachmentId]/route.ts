/**
 * K6F6-02: Single attachment API routes.
 * GET /api/scenarios/:id/attachments/:attachmentId - get attachment with data
 * DELETE /api/scenarios/:id/attachments/:attachmentId - delete attachment
 */

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "../../../../../../lib/db/client";
import { requireUser } from "../../../../../../lib/auth/require-user";
import { deleteAttachment, getAttachmentWithData } from "../logic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; attachmentId: string }> },
): Promise<NextResponse> {
  const cookieHeader = request.headers.get("cookie");
  const user = await requireUser(cookieHeader);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: scenarioId, attachmentId } = await params;
  const db = getDb();
  const result = await getAttachmentWithData(db, scenarioId, attachmentId, user.id);

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({ attachment: result.attachment });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; attachmentId: string }> },
): Promise<NextResponse> {
  const cookieHeader = request.headers.get("cookie");
  const user = await requireUser(cookieHeader);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: scenarioId, attachmentId } = await params;
  const db = getDb();
  const result = await deleteAttachment(db, scenarioId, attachmentId, user.id);

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({ success: true });
}
