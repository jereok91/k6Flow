# K6Flow — respaldo de métricas por polling

Cuando el WebSocket de métricas no está disponible, el panel cae a polling y las
tarjetas quedan en 0 porque `GET /api/runs/{id}` solo devuelve estado.

## Specs

S1 — El polling de respaldo debe actualizar la vista, no solo el estado.
Requerimiento autorizado por el usuario (resumen de la propuesta aceptada):
> "Que el polling también traiga métricas, para que el respaldo sirva de verdad cuando el WS no esté"

S2 — Debe actualizar los mismos valores que el frame `tick` del WS: VUs activos,
req/s, latencia media, p95 y error rate, y alimentar el gráfico igual que hoy.

S3 — Sin snapshot (run desconocido o todavía sin ventanas), el respaldo se comporta
como hoy: actualiza estado y no rompe la vista ni el cierre de la ejecución.

S4 — No se modifica el contrato existente: ni `GET /api/runs/{id}`, ni el frame del
WebSocket, ni el `MetricsFrame` compartido.

## Decisiones

- D1 — Endpoint nuevo `GET /api/runs/{runId}/metrics` en el orchestrator, con el
  mismo bearer que el resto de `/api/*` y `no-store`. Devuelve la última ventana
  recibida para ese run; 404 si no hay ninguna.
- D2 — La última ventana se guarda en `live.Server`, que ya implementa
  `metrics.FrameSink`. Caché acotada y por run; se descarta al terminar el run.
- D3 — El mapeo frame → estado del panel se extrae a una función pura compartida
  por el WS y el polling, para que no diverjan.

## Tasks

- [x] T1 Go: cachear la última ventana por run en `live.Server` + `LastFrame` + tests.
- [x] T2 Go: endpoint `/api/runs/{id}/metrics`, wiring y tests.
- [x] T3 Web: ruta proxy `/api/orchestrator/runs/[runId]/metrics` + test.
- [x] T4 Web: helper puro frame → métricas y uso en el polling del panel.
- [x] T5 Suites completas y cierre.

## Log

L1 (pedido original, verbatim):
> 1 si 2. ya lo comprobe y esta funcionando
(Responde a la propuesta numerada: 1 = implementar el polling con métricas; 2 = el
WebSocket ya funciona tras el arreglo de orígenes.)

## Evidencia

| Rebanada | Commit | Líneas | Verificación |
| --- | --- | --- | --- |
| Orchestrator: snapshot REST | `e0fa959` | 409 nuevas (`frames.go`, `frames_test.go`, `metrics.go`, `metrics_test.go`) + 41/−3 en `server.go`, `httpapi/server.go`, `cmd/server/main.go` | `go test ./...` 10 paquetes ok, `go vet` 0 |
| Web: polling con métricas | `48209e7` | 427 nuevas (`run-metrics.ts/.test.ts`, ruta `/metrics` y su test) + 34/−43 en `RunExecutionPanel.tsx` | typecheck shared/web 0, `pnpm test` 94 archivos / 1932 tests, build limpio 0 |

Prueba funcional del endpoint contra el stack real (run de 1 VU, 7 s, con un GET
por iteración): las dos primeras lecturas dan **404** (todavía sin ventana), luego
**200** con frames reales (`reqPerSec: 2`, `latencyMs`, `seq` 0→4 avanzando). Es
exactamente lo que el polling necesita y lo que el panel ignora en silencio cuando
no hay snapshot.

Límite de rebanada declarado: 957 líneas autoradas en dos commits. Se acepta como
unidad coherente (el endpoint solo no sirve sin consumidor; el consumidor solo no
tiene fuente) y se registra acá por superar la guía de ~400.

Implementation delegated to a bounded writer with restricted edit surfaces; the
parent re-ran every suite and exercised the endpoint against the live stack
instead of trusting the writer's report.

