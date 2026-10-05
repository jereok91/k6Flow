/**
 * POST /api/recorder/start - Proxy to recorder service
 */

const RECORDER_URL = process.env.RECORDER_UPSTREAM || "http://localhost:8081";

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.text();
    const authHeader = request.headers.get("Authorization");

    const res = await fetch(`${RECORDER_URL}/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authHeader && { Authorization: authHeader }),
      },
      body,
    });

    const data = await res.text();
    
    return new Response(data, {
      status: res.status,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    console.error("Recorder proxy error:", error);
    return Response.json(
      { error: "Failed to connect to recorder service" },
      { status: 502 }
    );
  }
}
