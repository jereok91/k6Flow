# Prompt de inicialización — K6Flow (Framework DevOps de Pruebas de Carga sobre K6)

> Copia todo lo que está debajo de la línea y pégalo como primer mensaje en tu agente de código (por ejemplo Claude Code), dentro de una carpeta vacía que será la raíz del monorepo.

---

## ROL

Eres un ingeniero de software senior full-stack y de DevOps. Vas a inicializar y construir, por fases, un proyecto nuevo desde cero. Trabaja de forma ordenada, explica brevemente lo que haces en cada paso, y **antes de tomar cualquier decisión que no esté definida en este documento, pregúntame** en lugar de asumir. Cuando asumas algo por necesidad, déjalo anotado en `docs/DECISIONES.md`.

## 1. QUÉ ES EL PROYECTO

El proyecto se llama **K6Flow** (escrito así: letra K, número 6, Flow). Úsalo como nombre del repositorio, de los paquetes y de la documentación.

Es una herramienta propia de DevOps para **pruebas de carga y rendimiento**, construida sobre **K6** (motor open source de Grafana). Permite diseñar escenarios de prueba de forma visual (editor de nodos estilo n8n), ejecutarlos en contenedores Docker aislados y ver las métricas en vivo.

Requisitos de fondo:

- **Reutilizable y desacoplada.** Debe servir para probar múltiples aplicaciones de la empresa. No debe contener ninguna referencia, dependencia ni lógica de un producto de negocio específico. Se instala una sola vez y cada escenario nuevo se resuelve configurando, sin reinstalar nada.
- **Autohospedada en un VPS.** La herramienta vive en un VPS con su propio dominio. El sistema a auditar es **otro servicio en otra IP o dominio**, accesible por IP o por nombre de dominio.
- **Instalación con un solo comando** (`docker compose up`).

## 2. ARQUITECTURA ACORDADA (no la cambies sin preguntarme)

Tres servicios propios más K6 como contenedores efímeros:

| Servicio       | Tecnología                         | Responsabilidad                                                                                                                                                                                                                                             |
| -------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web`          | **Next.js** (React, TypeScript)    | Toda la interfaz; editor visual de nodos; guardado de escenarios; autenticación de los usuarios de la herramienta; **traducción del grafo de nodos a script K6 en JavaScript**.                                                                             |
| `orchestrator` | **Go**                             | Servicio de larga duración. Recibe el script K6 ya armado + configuración; habla con el Docker Engine para lanzar, monitorear y detener contenedores K6; parsea métricas y las retransmite por WebSocket. También lanza y apaga el contenedor del grabador. |
| `recorder`     | **Node** (Playwright o Puppeteer)  | Navegador headless controlado en remoto para grabar sesiones contra la app objetivo. **Solo existe mientras dura una grabación.**                                                                                                                           |
| `k6` (efímero) | K6 en Docker                       | Un contenedor por prueba, creado al vuelo por el orquestador y eliminado al terminar.                                                                                                                                                                       |
| `db`           | Ver sección 9 (decisión pendiente) | Persistencia de escenarios, usuarios de la herramienta y resultados.                                                                                                                                                                                        |

### Decisiones ya tomadas

1. **Editor visual con React Flow** (`@xyflow/react`), no Vue Flow. El frontend es React.
2. **Orquestador en Go**, separado de Next.js porque es un proceso de larga duración que no encaja en funciones serverless.
3. **Next.js traduce el grafo a script K6**; el orquestador **solo recibe el script ya armado** y la configuración del contenedor. El orquestador no conoce el formato del grafo.
4. **Comunicación de control Next.js ↔ orquestador por REST** (lanzar prueba, detenerla, consultar estado). gRPC fue descartado por ahora.
5. **WebSocket (no SSE) para las métricas en vivo**: K6 escribe métricas JSON en tiempo real → el orquestador las parsea y retransmite → el frontend las pinta en un dashboard en vivo (peticiones por segundo, latencia, errores).
6. **Monorepo**. Separar en repos distintos solo si el equipo crece y cada pieza gana ciclo de vida independiente.
7. **Servicio de grabación separado en Node** (Playwright/Puppeteer están mejor soportados ahí que en Go), encendido y apagado bajo demanda por el orquestador.

## 3. FUNCIONALIDADES DEL EDITOR DE NODOS

### 3.1 Construcción manual (nodo por nodo)

Nodos arrastrables desde una barra lateral al lienzo, con configuración por nodo en un panel:

- **Autenticación / generación de token**: JWT, cookies u otros métodos (diseñar el nodo para que el método sea un tipo extensible). El token/cookie resultante queda disponible como variable para los nodos siguientes.
- **Petición HTTP**: método, URL (con variables), headers, body, parámetros.
- **Validación de respuesta**: checks sobre status, tiempos, contenido del body/headers (mapea a `check()` de K6).
- **Pool de usuarios de prueba**: carga de un CSV (por ejemplo 100 usuarios con usuario/contraseña) y reparto entre usuarios virtuales usando **`SharedArray`** de K6, de modo que cada VU tome sus credenciales sin duplicar memoria.
- Configuración global de la prueba: VUs, duración, rampas/etapas, thresholds.

### 3.2 Grabación de sesiones (entrada alternativa)

Además de armar nodos a mano, el usuario puede **grabar un ciclo completo de navegación** contra la app objetivo y convertirlo automáticamente en un grafo de nodos ya armado, que luego edita igual que cualquier otro.

- La grabación ocurre **del lado del servidor** (no en el navegador local del usuario, porque la herramienta vive en un VPS y el objetivo está en otra IP/dominio).
- El servicio `recorder` corre un navegador headless con Playwright/Puppeteer en su contenedor.
- La interfaz web lo controla **casi en vivo**: los frames del navegador se transmiten por WebSocket y se pintan en un canvas en el frontend; cada clic y tecla del usuario viaja de vuelta por el mismo canal y se reproduce en el navegador remoto.
- Todo el tráfico de red que genera la página se captura (formato tipo HAR) y se **traduce a nodos** (captura → nodos; es la transformación inversa a nodos → script K6).
- Debe permitir filtrar hosts/recursos irrelevantes (analytics, imágenes, fuentes, etc.) antes de generar los nodos.
- **Ciclo de vida:** el contenedor `recorder` se crea cuando el usuario pulsa "Iniciar grabación" y se **apaga y elimina** al terminar o cuando la sesión se cierra o expira por inactividad. No debe quedar consumiendo recursos del VPS.

## 4. ESTRUCTURA DEL MONOREPO

Crea esta estructura (ajústala solo si hay una razón fuerte, y documenta el cambio):

```
/
├─ apps/
│  ├─ web/                 # Next.js + React Flow
│  ├─ orchestrator/        # Go
│  └─ recorder/            # Node + Playwright
├─ packages/
│  └─ shared/              # Tipos/esquemas compartidos (grafo de nodos, contrato REST, mensajes WS)
├─ deploy/
│  ├─ docker-compose.yml
│  ├─ docker-compose.dev.yml
│  └─ .env.example
├─ docs/
│  ├─ ARQUITECTURA.md
│  ├─ DECISIONES.md
│  └─ api/                 # OpenAPI del orquestador
├─ scripts/
├─ .github/workflows/      # CI (lint, test, build)
└─ README.md
```

Usa un gestor de workspaces para la parte JS/TS (pnpm workspaces recomendado) y un `go.mod` propio dentro de `apps/orchestrator`.

## 5. CONTRATOS ENTRE SERVICIOS

Define estos contratos **primero** (en `packages/shared` y `docs/api`) antes de implementar, y pídeme revisión.

### 5.1 REST: web → orchestrator (control)

Propón y documenta en OpenAPI al menos:

- `POST /v1/runs` — lanza una prueba. Recibe: script K6 (string), configuración del contenedor (VUs, duración, límites de CPU/memoria), archivos adjuntos como el CSV del pool de usuarios, y metadatos. Devuelve `runId`.
- `GET /v1/runs/{runId}` — estado actual (`pending | running | finished | failed | stopped`).
- `POST /v1/runs/{runId}/stop` — detiene la prueba y elimina el contenedor.
- `GET /v1/runs/{runId}/summary` — resumen final de métricas.
- `POST /v1/recordings` — inicia una sesión de grabación (lanza el contenedor `recorder`). Devuelve `recordingId` y la información para conectarse al stream.
- `POST /v1/recordings/{recordingId}/stop` — detiene la grabación, entrega la captura y **elimina el contenedor**.
- `GET /healthz`.

Protege el REST con autenticación entre servicios (token compartido por entorno como mínimo). El orquestador **nunca** debe quedar expuesto a internet; solo la red interna de Docker.

### 5.2 WebSocket

- **Métricas en vivo** (`/ws/runs/{runId}`): mensajes JSON con peticiones/seg, latencias (promedio, p90, p95, p99), tasa de errores, VUs activos, checks fallidos. Define un esquema versionado.
- **Stream del grabador** (`/ws/recordings/{recordingId}`): frames del navegador hacia el frontend y eventos de mouse/teclado de vuelta. Evalúa Chrome DevTools Protocol `Page.startScreencast` para obtener los frames de forma eficiente.

Decide con mi aprobación si el navegador del usuario se conecta directo al orquestador por WebSocket o si pasa a través de Next.js (proxy). Explícame el tradeoff antes de implementar.

### 5.3 Esquema del grafo de nodos

Define en `packages/shared` un esquema tipado (TypeScript + validación, por ejemplo Zod) del grafo: tipos de nodo, sus parámetros, conexiones y variables. Este esquema es la fuente de verdad que usan el editor, el traductor a K6 y el traductor de grabaciones.

## 6. TRADUCTORES (en `apps/web`)

Implementa como módulos puros y **muy bien testeados** (son el corazón del producto):

1. **Grafo → script K6 (JavaScript)**: recorre el grafo y genera un script válido con `options`, `SharedArray` para el pool de usuarios, `http.*`, `check()`, manejo de variables (token/cookie propagados entre nodos), y thresholds. Debe ser determinista (mismo grafo ⇒ mismo script).
2. **Captura de grabación → grafo**: convierte las peticiones capturadas en nodos de petición HTTP ordenados, detecta candidatos a nodo de autenticación y valores dinámicos a parametrizar, y respeta los filtros definidos por el usuario.

Incluye pruebas unitarias con casos reales y un test que **ejecute el script generado con K6** contra un servidor de prueba local para confirmar que es válido.

## 7. ORQUESTADOR EN GO — REQUISITOS

- Usa el **SDK oficial de Docker para Go** para crear, iniciar, monitorear y eliminar contenedores. Cada prueba = un contenedor K6 nuevo, con **límites de CPU y memoria**, red controlada y **eliminación garantizada** al finalizar, fallar o cancelarse (incluyendo si el orquestador se reinicia: reconcilia contenedores huérfanos al arrancar).
- Entrega el script y los archivos al contenedor K6 (volumen temporal o copia al contenedor), sin dejar secretos en disco más tiempo del necesario.
- Para métricas: ejecuta K6 con salida JSON en streaming, parsea línea a línea, agrega y retransmite por WebSocket. Persiste el resumen final.
- Concurrencia segura con goroutines y `context` para cancelación; cierre ordenado (graceful shutdown).
- Logs estructurados, endpoint `/healthz`, configuración por variables de entorno.
- Un **límite configurable de pruebas simultáneas** y de VUs máximos por prueba para no tumbar el VPS.
- Pruebas unitarias y de integración (puedes usar contenedores reales en CI).

## 8. SERVICIO RECORDER EN NODE — REQUISITOS

- Playwright (o Puppeteer; recomiéndame cuál y por qué) en un contenedor con el navegador y sus dependencias.
- Expone el stream de frames y recibe eventos de entrada por WebSocket.
- Captura todo el tráfico de red (peticiones, respuestas, headers, bodies relevantes) y lo entrega al finalizar.
- Maneja HTTPS del sitio objetivo (certificados, redirecciones, cookies) sin requerir instalar nada en el equipo del usuario.
- **Apagado automático** por inactividad y por duración máxima de sesión; limpieza total al terminar.
- Un solo contenedor por grabación, aislado.

## 9. DECISIONES PENDIENTES (pregúntame antes de implementarlas)

- **Base de datos**: aún no está definida. Propón 2 opciones con pros y contras (por ejemplo PostgreSQL vs SQLite) considerando instalación de un solo comando y escenarios/usuarios/resultados. No asumas.
- **Autenticación de los usuarios de la herramienta**: método (credenciales propias, OAuth, etc.) y roles.
- **Almacenamiento de resultados históricos** y política de retención.
- **Conexión del navegador a los WebSockets**: directa o vía proxy de Next.js (ver 5.2).
- **Playwright vs Puppeteer**.

## 10. SEGURIDAD (obligatorio considerarlo desde el inicio)

- El orquestador necesita acceso al Docker Engine (socket de Docker), lo cual es un privilegio alto. Documenta el riesgo y aplica la mitigación más razonable (por ejemplo, un proxy del socket con permisos limitados o rootless) y pregúntame cuál prefiero.
- Esta herramienta puede generar **carga contra sistemas reales**. Incluye una **lista de destinos permitidos** configurable y una confirmación explícita en la interfaz antes de lanzar una prueba contra un objetivo, para evitar usos accidentales o abusivos. El grabador y K6 no deben poder alcanzar la red interna de la propia herramienta (evitar SSRF hacia los servicios internos).
- Credenciales y CSV de usuarios de prueba: nunca en logs, almacenamiento cifrado o con retención mínima.
- Secretos solo por variables de entorno; incluye `.env.example` sin valores reales.
- Dependencias fijadas en versión y escaneo básico en CI.

## 11. EMPAQUETADO

- `deploy/docker-compose.yml` con: `web`, `orchestrator`, `db` y la red interna. K6 y `recorder` **no** están como servicios permanentes: los lanza el orquestador bajo demanda.
- Un `docker-compose.dev.yml` con hot reload para desarrollo.
- Dockerfiles multi-stage y livianos para cada servicio.
- Un reverse proxy con HTTPS (por ejemplo Caddy o Traefik) para el dominio de la herramienta; propón la opción más simple.
- Instalación con un solo comando y un README claro de despliegue en un VPS limpio.

## 12. PLAN DE EJECUCIÓN POR FASES

Trabaja **una fase a la vez** y detente al final de cada una para que yo revise antes de continuar.

**Fase 0 — Fundaciones.** Estructura del monorepo, workspaces, linters/formatters, CI básico, `docs/DECISIONES.md`, y un `docker-compose` mínimo que levante los servicios vacíos con healthchecks. Resuelve conmigo las decisiones pendientes de la sección 9 que bloqueen esta fase.

**Fase 1 — Contratos.** Esquema del grafo, OpenAPI del orquestador, esquemas de mensajes WebSocket. Para revisión.

**Fase 2 — Núcleo de ejecución.** Orquestador en Go: lanzar un script K6 fijo en un contenedor, monitorearlo, detenerlo y limpiarlo. Sin interfaz todavía; pruébalo con `curl`.

**Fase 3 — Métricas en vivo.** Parseo de la salida de K6 y retransmisión por WebSocket; un dashboard mínimo en `web`.

**Fase 4 — Editor visual.** React Flow, los nodos de la sección 3.1, guardado de escenarios y autenticación de usuarios.

**Fase 5 — Traductor grafo → K6.** Con pruebas, y flujo completo: dibujar → generar script → ejecutar → ver métricas.

**Fase 6 — Pool de usuarios.** Carga de CSV y `SharedArray`.

**Fase 7 — Grabador.** Servicio `recorder`, control remoto por stream, captura de tráfico, ciclo de vida bajo demanda y apagado garantizado.

**Fase 8 — Captura → grafo.** Traductor de grabaciones a nodos y edición posterior.

**Fase 9 — Endurecimiento.** Seguridad (sección 10), límites, reconciliación de huérfanos, documentación final y guía de despliegue.

## 13. CRITERIOS DE ACEPTACIÓN GLOBALES

- `docker compose up` en un VPS limpio deja la herramienta funcionando y accesible por dominio con HTTPS.
- Un usuario puede dibujar un escenario con autenticación + peticiones + validaciones + pool de 100 usuarios, ejecutarlo contra un destino externo y ver métricas en vivo.
- Un usuario puede grabar una sesión contra una app externa, obtener el grafo de nodos, editarlo y ejecutarlo.
- Tras finalizar o cancelar cualquier prueba o grabación, **no queda ningún contenedor huérfano**.
- Ninguna parte del código menciona ni depende de un producto de negocio específico.
- El mismo grafo siempre genera el mismo script K6.

## 14. REGLAS DE TRABAJO

- Idioma: documentación y comentarios importantes en **español**; nombres de código en inglés.
- Commits pequeños y descriptivos; una rama por fase si usas git.
- No introduzcas tecnologías no listadas sin proponerlas primero con su justificación.
- Si algo de este documento es ambiguo o contradictorio, **pregúntame** antes de continuar.
- Al terminar cada fase: resume lo hecho, lo que falta, riesgos detectados y qué necesitas de mí para la siguiente.

**Empieza ahora por la Fase 0.** Antes de escribir código, confírmame que entendiste la arquitectura con un resumen breve en tus propias palabras y hazme las preguntas que necesites sobre las decisiones pendientes de la sección 9.

- NOTA: Final la base de datos que debo usar es PostgreSQL
