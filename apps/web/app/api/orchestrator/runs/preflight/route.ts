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
    // Pass the orchestrator body through unchanged (including 422
    // `{version, code, message}` limit errors) instead of re-encoding it.
    const data = await res.text();
    return new Response(data, {
      status: res.status,
      headers: { "Content-Type": res.headers.get("Content-Type") ?? "application/json" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to connect to orchestrator" },
      { status: 502 }
    );
  }
}
