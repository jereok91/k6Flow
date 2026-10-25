# K6Flow — actualizaciones de seguridad (octubre 2026)

Alcance: parchear los avisos que **sí** afectan al árbol: Next.js (4 critical), el decodificador
Brotli de Node (CVE-2026-111497) y Go (EOL + CVE-2026-32283/27140), más las dependencias directas
que el audit marca.

## Specs

S1 (verbatim, user): "ayudame a validar si se ncita parchar segn l;o que yo tengo" + "si ejecutalos"
  - Cada aviso se valida contra el árbol real (`pnpm audit`, versiones instaladas) y contra fuentes
    oficiales (OSV, nodejs.org, go.dev); se parchea sólo lo que aplica y cada frente queda verificado.

S2 (validación, evidencia): Next 16.1.6 está en rango vulnerable (`pnpm audit`: 4 critical, 14 high,
  16 moderate, 4 low; parches ≥16.3.3 y ≥16.4.1). Node 22.22.0 y el host 24.13.0 son anteriores a
  22.23.4/24.22.1 (fix de Brotli). Go declarado 1.25.0 con imágenes 1.25.7: la última 1.25 es
  1.25.14 y 1.25 está fuera de soporte. `CVE-2026-96889` y los PHP no existen en OSV; PHP, Postiz,
  Bun, Python y Envoy no están en el stack.

S3 (versiones objetivo): `next@^16.4.3` · `node:22.23.4` en todas las imágenes y
`engines.node >=22.23.4` · `go 1.26` con `golang:1.26.10-alpine3.23` · `playwright@^1.55.1` con base
`mcr.microsoft.com/playwright:v1.55.1-noble` · `ws@^8.21.0` · `zod@^4.6.6`.

## Tasks

- P1 — Go: `go.mod` a 1.26 y las imágenes a `golang:1.26.10-alpine3.23`; `go build/test/vet`.
- P2 — Node: `node:22.23.4` en web, recorder y todo-en-uno (incluido el binario que se copia sobre
  la base de Playwright) + `engines`.
- P3 — Dependencias: next 16.4.3, playwright 1.55.1 con su base de navegador, ws 8.21, zod 4.6.6.
- P4 — Verificación: typecheck, suites, build de Next, rebuild de las dos variantes y arranque real
  (login, proxies, flujo de grabación).

## Log

- L1 (user, verbatim): "ayudame a validar si mi codigo Node.js, decodificador Brotli (CVE-2026-111497,
  CVSS 9.8)…" (lista de avisos) + "ayudame a validar si se ncita parchar segn l;o que yo tengo ??"
- L2 (validación, 2026-10-25): OSV confirma `CVE-2026-111497` (Brotli 1.0.3–1.2.0 → 1.0.10/1.1.1/1.2.1;
  Node parcheado en 22.23.4/24.22.1/26.12.1), `GHSA-673q-mjm6-r5xr` (next 16.0.0→16.4.1) y
  `CVE-2026-32283`/`CVE-2026-27140` (Go). `CVE-2026-96889`, `CVE-2026-109618` y `CVE-2026-109619`
  devuelven 404 en OSV. `pnpm audit --prod` sobre el árbol: 49 avisos (4 critical en `next`,
  y playwright/ws/zod/postcss/sharp en el resto).
- L3 (decisión): se parchea en el orden Go → Node → dependencias → Next, un commit por frente, y cada
  frente se verifica antes de pasar al siguiente; Next va último porque son tres minors.
