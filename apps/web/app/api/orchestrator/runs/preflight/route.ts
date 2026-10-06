import { NextResponse } from "next/server";

const ORCHESTRATOR_URL =
  process.env.ORCHESTRATOR_URL || "http://localhost:8080";
const ORCHESTRATOR_TOKEN = process.env.ORCHESTRATOR_TOKEN || "";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const res = await fetch(`${ORCHESTRATOR_URL}/api/runs/preflight`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ORCHESTRATOR_TOKEN}`,
      },
      body: JSON.stringify(body),
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
