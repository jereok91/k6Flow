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

# Guarda: la librería de Playwright se instala desde el lockfile mientras los navegadores vienen de
# la imagen base, así que ambas versiones tienen que coincidir. Si una capa cacheada deja una
# librería distinta (pasó: 1.52 sobre una base 1.64) o falta el headless shell, el build falla acá
# en vez de romper la primera grabación en producción.
RUN node -e "const { chromium } = require('playwright'); chromium.launch({ headless: true }).then(async (browser) => { console.log('chromium', browser.version()); await browser.close(); }).catch((error) => { console.error('Playwright no puede lanzar Chromium:', error.message.split('\\n')[0]); process.exit(1); })"

# Environment
ENV PORT=8081
ENV NODE_ENV=production

EXPOSE 8081

# Health check
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q --spider http://localhost:8081/healthz || exit 1

# Run with tsx (handles TypeScript imports correctly)
CMD ["npx", "tsx", "src/main.ts"]
