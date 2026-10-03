import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // K6F3-04 contract-05 routing: the browser opens same-origin
  // ws(s)://<web>/api/ws/runs/{id}; the proxy forwards to the orchestrator's
  // internal /ws/runs/{id} — the orchestrator port is never exposed.
  // K6F7: recorder routes also proxied through the frontend.
  async rewrites() {
    const orchestratorUpstream = process.env.ORCHESTRATOR_WS_UPSTREAM ?? "http://orchestrator:8080";
    const recorderUpstream = process.env.RECORDER_UPSTREAM ?? "http://recorder:8081";
    return [
      { source: "/api/ws/:path*", destination: `${orchestratorUpstream}/ws/:path*` },
      { source: "/api/recorder/:path*", destination: `${recorderUpstream}/api/recorder/:path*` },
      { source: "/ws/recordings/:path*", destination: `${recorderUpstream}/ws/recordings/:path*` },
    ];
  },
};

export default nextConfig;
