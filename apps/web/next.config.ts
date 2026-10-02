import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // K6F3-04 contract-05 routing: the browser opens same-origin
  // ws(s)://<web>/api/ws/runs/{id}; the proxy forwards to the orchestrator's
  // internal /ws/runs/{id} — the orchestrator port is never exposed.
  async rewrites() {
    const upstream = process.env.ORCHESTRATOR_WS_UPSTREAM ?? "http://orchestrator:8080";
    return [{ source: "/api/ws/:path*", destination: `${upstream}/ws/:path*` }];
  },
};

export default nextConfig;
