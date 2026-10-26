import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { matchesGlob } from "node:path";
import { parse } from "yaml";

const load = (path: string) => parse(readFileSync(path, "utf8"));

// Human authorization 2026-10-21: in development only, the orchestrator may publish
// exactly 127.0.0.1:8080 (WebSocket metrics streaming). Production stays unpublished.
const ORCHESTRATOR_DEV_PORTS = ["127.0.0.1:8080:8080"];

function checkServices(services: Record<string, any>, opts: { allowOrchestratorDevSocket?: boolean; allowOrchestratorDevPort?: boolean } = {}) {
  assert.deepEqual(Object.keys(services).sort(), ["db", "orchestrator", "recorder", "setup", "web"]);
  assert.equal(services.db.ports, undefined, "db must not publish ports");
  if (opts.allowOrchestratorDevPort && services.orchestrator.ports !== undefined) {
    assert.deepEqual(services.orchestrator.ports, ORCHESTRATOR_DEV_PORTS, "dev orchestrator may publish only loopback 8080");
  } else {
    assert.equal(services.orchestrator.ports, undefined, "orchestrator must not publish ports");
  }
  for (const [name, service] of Object.entries(services)) {
    if (name === "setup") {
      // One-shot: aplica migraciones y siembra el admin, después sale. No tiene sonda de salud ni
      // puede reiniciarse (volvería a correr el seed en cada arranque).
      assert.equal(service.restart, "no", "setup must not restart");
      assert.equal(service.privileged, undefined);
      continue;
    }
    assert.ok(service.healthcheck.test.length > 1);
    assert.equal(service.privileged, undefined);
    const hasSocket = (service.volumes ?? []).some((v: string) => v.includes("docker.sock"));
    if (opts.allowOrchestratorDevSocket) {
      // Human authorization 2026-10-02 (Phase 2 review gate): the development override may
      // mount docker.sock on the orchestrator ONLY, so it can manage per-run k6 containers
      // (init §7). Production must remain socket-free (asserted by the production test);
      // security hardening of this dev mount is Phase 9 (init §10).
      assert.ok(!hasSocket || name === "orchestrator", `${name} must not mount docker.sock`);
    } else {
      assert.ok(!hasSocket, `${name} must not mount docker.sock`);
    }
  }
}

test("production isolates Go and PostgreSQL with process health probes", () => {
  const config = load("deploy/docker-compose.yml");
  checkServices(config.services);
  assert.equal(config.services.web.build.target, "production");
  assert.equal(config.services.orchestrator.build.target, "production");
  assert.match(config.services.db.image, /^postgres:17\.\d+-alpine\d+\.\d+$/);
  assert.equal(config.networks.backend.internal, true);
  assert.deepEqual(config.services.orchestrator.networks, ["backend", "k6runner"]);
  assert.deepEqual(config.services.db.networks, ["backend"]);
  for (const name of ["web", "orchestrator"]) {
    assert.equal(config.services[name].depends_on, undefined, "process health is independent of DB");
  }
  // Human authorization 2026-10-02 (Phase 4, K6F4-01b): the production web
  // service may receive DATABASE_URL for own-credential auth storage; the
  // orchestrator stays strictly DB-free (process health independent of the DB).
  assert.ok(config.services.web.environment?.DATABASE_URL, "web must receive DATABASE_URL for auth storage");
  assert.equal(config.services.orchestrator.environment?.DATABASE_URL, undefined, "orchestrator must stay DB-free");
  assert.match(config.services.web.healthcheck.test.join(" "), /\/api\/healthz/);
  assert.match(config.services.orchestrator.healthcheck.test.join(" "), /8080\/healthz/);
  assert.ok(config.services.db.healthcheck.test.join(" ").includes("pg_isready"));
});

test("development switches build targets without publishing internal services", () => {
  const base = load("deploy/docker-compose.yml");
  const dev = load("deploy/docker-compose.dev.yml");
  const merged = { ...base.services };
  for (const [name, override] of Object.entries(dev.services)) {
    merged[name] = { ...merged[name], ...(override as object) };
  }
  checkServices(merged, { allowOrchestratorDevSocket: true, allowOrchestratorDevPort: true });
  // The dev-only socket authorization is exclusive to the orchestrator override.
  for (const [name, override] of Object.entries(dev.services)) {
    const volumes: string[] = (override as { volumes?: string[] }).volumes ?? [];
    if (volumes.some((v) => v.includes("docker.sock"))) {
      assert.equal(name, "orchestrator", "dev override may mount docker.sock only on orchestrator");
    }
  }
  assert.equal(merged.web.build.target, "development");
  assert.equal(merged.orchestrator.build.target, "development");
  assert.ok(merged.web.volumes.includes("../apps/web/app:/workspace/apps/web/app:ro"));
  assert.ok(merged.orchestrator.volumes.includes("../apps/orchestrator:/src:ro"));
});

test("contract rejects accidental public Go ports and extra services", () => {
  const { services } = load("deploy/docker-compose.yml");
  assert.throws(() => checkServices({ ...services, recorder: {} }));
  assert.throws(() => checkServices({ ...services, orchestrator: { ...services.orchestrator, ports: ["8080:8080"] } }));
  // Production rejects even the loopback dev mapping.
  assert.throws(() => checkServices({ ...services, orchestrator: { ...services.orchestrator, ports: ORCHESTRATOR_DEV_PORTS } }));
  // Development allows only the exact loopback mapping, and never DB ports.
  const dev = { allowOrchestratorDevPort: true };
  assert.throws(() => checkServices({ ...services, orchestrator: { ...services.orchestrator, ports: ["8080:8080"] } }, dev));
  assert.throws(() => checkServices({ ...services, orchestrator: { ...services.orchestrator, ports: ["127.0.0.1:8080:8080", "127.0.0.1:9090:9090"] } }, dev));
  assert.throws(() => checkServices({ ...services, db: { ...services.db, ports: ["127.0.0.1:5432:5432"] } }, dev));
});

test("Docker build stages separate development from non-root production", () => {
  for (const path of ["apps/web/Dockerfile", "apps/orchestrator/Dockerfile"]) {
    const lines = readFileSync(path, "utf8").split("\n");
    const stages = lines.filter(line => /^FROM /i.test(line)).map(line => line.split(/\s+/));
    assert.ok(stages.length >= 3);
    assert.ok(stages.some(parts => parts.at(-1) === "development"));
    assert.equal(stages.at(-1)?.at(-1), "production");
    const final = lines.slice(lines.findLastIndex(line => /^FROM /i.test(line)));
    assert.ok(final.some(line => /^USER (node|app)$/.test(line)));
    assert.ok(final.some(line => /^COPY --from=builder /.test(line)));
    assert.ok(!final.some(line => /^RUN .*\b(pnpm install|go build)\b/.test(line)));
  }
});

test("build allowlist includes Go source but excludes secrets and host outputs", () => {
  const rules = readFileSync(".dockerignore", "utf8").split("\n")
    .map(line => line.trim()).filter(line => line && !line.startsWith("#"));
  const included = (path: string) => {
    const parts = path.split("/");
    return parts.every((_, index) => {
      const candidate = parts.slice(0, index + 1).join("/");
      let allowed = true;
      for (const rule of rules) {
        const negate = rule.startsWith("!");
        const pattern = (negate ? rule.slice(1) : rule).replace(/\/$/, "");
        if (matchesGlob(candidate, pattern)) allowed = negate;
      }
      return allowed;
    });
  };
  for (const path of ["apps/orchestrator/cmd/server/main.go", "apps/web/app/api/healthz/route.ts", "pnpm-lock.yaml"]) {
    assert.equal(included(path), true, `source excluded: ${path}`);
  }
  for (const path of ["deploy/.env.example", "apps/web/.next/server.js", "apps/orchestrator/server", "node_modules/yaml/index.js", "doc/UX_UI/mock.png", "apps/web/app/.env.local", "apps/web/app/private.key"]) {
    assert.equal(included(path), false, `unsafe context input: ${path}`);
  }
});

test("development recorder ports target the port the recorder listens on", () => {
  const dockerfile = readFileSync("apps/recorder/Dockerfile", "utf8");
  const exposed = dockerfile.match(/^EXPOSE (\d+)$/m)?.[1];
  assert.ok(exposed, "recorder Dockerfile must EXPOSE its port");
  const ports: string[] = load("deploy/docker-compose.dev.yml").services.recorder.ports ?? [];
  assert.ok(ports.length > 0, "dev recorder should publish a loopback port");
  for (const mapping of ports) {
    assert.match(mapping, /^127\.0\.0\.1:/, `recorder port must bind loopback only: ${mapping}`);
    assert.equal(mapping.split(":").at(-1), exposed, `recorder port must target ${exposed}: ${mapping}`);
  }
});

test("long-lived recorder runs under an init that reaps exited browser processes", () => {
  assert.equal(load("deploy/docker-compose.yml").services.recorder.init, true);
});

test("CI checks both languages and the runtime boundary", () => {
  const ci = load(".github/workflows/ci.yml");
  const commands = ci.jobs.check.steps.map((step: any) => step.run ?? "").join("\n");
  for (const command of ["pnpm test", "pnpm lint", "pnpm --filter @k6flow/web build", "go test ./...", "go vet ./...", "go build ./...", "bash scripts/check-phase-0-compose.sh", "pnpm --filter @k6flow/recorder exec playwright install --with-deps chromium", "pnpm --filter @k6flow/recorder test"]) {
    assert.ok(commands.includes(command), `CI missing ${command}`);
  }
});

// Guarda de 2026-10-25: al verificar la imagen publicada se comprobó que un archivo extra con
// `ports` NO reemplaza el del compose base; Docker Compose fusiona las listas y termina publicando
// los dos puertos (3000 y el nuevo). El puerto del host se cambia sólo con WEB_PORT.
test("published composes publish exactly one web port and let WEB_PORT move it", () => {
  for (const file of ["deploy/docker-compose.release.yml", "deploy/docker-compose.all-in-one.yml"]) {
    const config = load(file);
    const mappings: string[] = Object.values(config.services).flatMap((service: any) => service.ports ?? []);
    assert.deepEqual(mappings, ["${WEB_PORT:-3000}:3000"], `${file} must publish only the web port, from WEB_PORT`);
  }
});
