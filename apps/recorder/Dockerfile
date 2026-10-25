# K6Flow Recorder - Node.js with Playwright
FROM mcr.microsoft.com/playwright:v1.64.1-noble

WORKDIR /app

# La base de Playwright trae Node 20: se le reemplaza por el 22 parcheado (CVE-2026-111497).
COPY --from=node:22.23.4-bookworm-slim /usr/local/bin/node /usr/local/bin/node

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

# Copy workspace files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/recorder/package.json apps/recorder/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source (no build needed - using experimental-strip-types)
COPY packages/shared packages/shared
COPY apps/recorder apps/recorder

WORKDIR /app/apps/recorder

# Environment
ENV PORT=8081
ENV NODE_ENV=production

EXPOSE 8081

# Health check
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q --spider http://localhost:8081/healthz || exit 1

# Run with tsx (handles TypeScript imports correctly)
CMD ["npx", "tsx", "src/main.ts"]
