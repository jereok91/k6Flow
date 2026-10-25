// Genera las capturas y el video corto del README contra la app corriendo.
//
// Uso (con el stack dev arriba en http://127.0.0.1:3000 y una sesión válida):
//   CAPTURE_SESSION=<token de sesión> node scripts/capture-media.mjs
//
// La sesión se crea a mano para no tocar credenciales:
//   insert into sessions (token, user_id, expires_at) values ('<token>', '<user id>', now() + interval '30 minutes');
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const require = createRequire(join(root, "apps/recorder/package.json"));
const { chromium } = require("playwright");

const BASE = process.env.CAPTURE_BASE ?? "http://127.0.0.1:3000";
const TOKEN = process.env.CAPTURE_SESSION;
const SHOTS = join(root, "docs/media/screens");
const VIDEO_DIR = join(root, "docs/media/.video-tmp");
const REVIEW_PATH = process.env.CAPTURE_REVIEW ?? "/recorder/review";
const EDITOR_PATH = process.env.CAPTURE_EDITOR ?? "/editor";

if (!TOKEN) {
  console.error("Falta CAPTURE_SESSION (token de sesión de la app).");
  process.exit(1);
}

mkdirSync(SHOTS, { recursive: true });
rmSync(VIDEO_DIR, { recursive: true, force: true });
mkdirSync(VIDEO_DIR, { recursive: true });

/** Centra el grafo del editor antes de capturarlo. */
async function fitGraph(page) {
  const control = page.locator(".react-flow__controls-fitview");
  if (await control.count()) {
    await control.click().catch(() => {});
    await page.waitForTimeout(800);
  }
}

const shots = [
  { name: "dashboard", path: "/", waitFor: ".metric-card" },
  { name: "editor", path: EDITOR_PATH, waitFor: ".react-flow__node" },
  { name: "recorder", path: "/recorder", waitFor: "button" },
  { name: "review", path: REVIEW_PATH, waitFor: ".card" },
  { name: "recordings", path: "/recordings", waitFor: ".card" },
  { name: "scenarios", path: "/scenarios", waitFor: "table, .card" },
  { name: "executions", path: "/executions", waitFor: "table, .card" },
  { name: "import", path: "/import", waitFor: "input, .card" },
];

const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const sessionCookie = [{ name: "k6flow_session", value: TOKEN, domain: "127.0.0.1", path: "/" }];

const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
context.setDefaultTimeout(30000);
await context.addCookies(sessionCookie);

const page = await context.newPage();

for (const shot of shots) {
  await page.goto(`${BASE}${shot.path}`, { waitUntil: "networkidle" });
  if (shot.waitFor) {
    await page.waitForSelector(shot.waitFor, { timeout: 20000 }).catch(() => {
      console.warn(`sin selector para ${shot.name}: la captura puede salir vacía`);
    });
  }
  if (shot.path.includes("/editor")) await fitGraph(page);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(SHOTS, `${shot.name}.png`) });
  console.log(`captura: ${shot.name}.png`);
}

await context.close();

// Recorrido grabado (~20 s): tablero → grabaciones → revisión → editor.
const videoContext = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: VIDEO_DIR, size: { width: 1440, height: 900 } },
});
videoContext.setDefaultTimeout(30000);
await videoContext.addCookies(sessionCookie);
const tour = await videoContext.newPage();

await tour.goto(`${BASE}/`, { waitUntil: "networkidle" });
await tour.waitForTimeout(3000);
await tour.goto(`${BASE}/recordings`, { waitUntil: "networkidle" });
await tour.waitForTimeout(2500);
await tour.goto(`${BASE}${REVIEW_PATH}`, { waitUntil: "networkidle" });
await tour.waitForTimeout(3000);
await tour.mouse.move(700, 500);
await tour.mouse.wheel(0, 600);
await tour.waitForTimeout(2500);
await tour.goto(`${BASE}${EDITOR_PATH}`, { waitUntil: "networkidle" });
await tour.waitForSelector(".react-flow__node", { timeout: 20000 }).catch(() => {});
await fitGraph(tour);
await tour.waitForTimeout(3500);

await videoContext.close();
await browser.close();

// El .webm se finaliza al cerrar el contexto; el archivo queda en el directorio temporal.
const recorded = readdirSync(VIDEO_DIR).filter((name) => name.endsWith(".webm"));
if (recorded.length === 0) {
  console.warn("no se grabó video");
} else {
  copyFileSync(join(VIDEO_DIR, recorded[0]), join(root, "docs/media/demo.webm"));
  rmSync(VIDEO_DIR, { recursive: true, force: true });
  console.log("video: docs/media/demo.webm");
}
