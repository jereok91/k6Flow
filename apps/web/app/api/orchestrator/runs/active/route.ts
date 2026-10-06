import { NextResponse } from "next/server";

const ORCHESTRATOR_URL =
  process.env.ORCHESTRATOR_URL || "http://localhost:8080";
const ORCHESTRATOR_TOKEN = process.env.ORCHESTRATOR_TOKEN || "";

export async function GET() {
  try {
    const res = await fetch(`${ORCHESTRATOR_URL}/api/runs/active`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${ORCHESTRATOR_TOKEN}`,
      },
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to connect to orchestrator" },
      { status: 502 }
    );
  }
}
