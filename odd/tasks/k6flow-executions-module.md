# K6Flow — Módulo de Ejecuciones

**Fecha inicio:** 2026-10-06
**Branch:** main
**Spec:** doc/promt/ejecusiones.md

## Decisiones tomadas

| ID | Decisión | Valor |
|----|----------|-------|
| D1 | Fuente de métricas | JSON output (actual) |
| D2 | Librería de gráficas | uPlot |
| D3 | Almacenamiento de series | SQLite + rollups |
| D4 | Pausa/Reanudación | Ocultar en v1 |
| D5 | Percentiles | t-digest |
| D6 | Post-v1 | Programación, webhooks, CI fuera |
| D7 | Trazas | Muestras de fallos agrupadas |

## Fases

### X1 — Ciclo de vida mínimo
- [x] Máquina de estados completa (QUEUED→STARTING→RUNNING→STOPPING→terminal)
- [x] Tabla run_events para auditoría de transiciones
- [x] Preflight básico (validación escenario, capacidad)
- [x] Detención ordenada y forzada
- [x] Resultado final por código de salida + umbrales

### X2 — Pipeline de métricas
- [x] t-digest para percentiles correctos
- [x] Ring buffer en memoria
- [x] Eventos WS: hello, snapshot, tick, state, end
- [x] Persistencia de series (run_series)
- [x] Reconexión con lastSeq

### X3 — Vista en vivo mejorada
- [x] 4 KPIs con sparklines
- [x] 2 gráficas uPlot (RPS, Latencia)
- [x] Modo seguir/explorar
- [x] Estados de conexión visibles
- [x] Banner de alertas

### X4 — Endpoints, fallos y logs
- [x] Tabla métricas por endpoint
- [x] Agrupación de fallos (endpoint × status × error_code)
- [x] Muestreo de ejemplos (max 20 por grupo)
- [x] Flujo de logs con backpressure
- [x] Recursos del contenedor (CPU/mem)

### X5 — Lista y lanzamiento global
- [x] Canal `/ws/runs` para resumen de activas
- [x] Página /executions con pestañas En curso/En cola
- [x] Contador en sidebar
- [x] Asistente "Nueva prueba" con preflight completo
- [x] Encolado si excede límite

### X6 — Historial y comparación
- [x] Listado con filtros y paginación cursor
- [x] Detalle finalizado con zoom de rango
- [x] Comparación 2-4 ejecuciones
- [x] Línea base y detección de regresión
- [x] Exportación HTML/CSV/JSON

### X7 — Control avanzado
- [x] Detención de emergencia global
- [x] Auto-detención por saturación
- [x] Notificaciones (campana)
- [x] Límites duros en orquestador
- [x] Auditoría completa

## Commits
- `f5f780f` feat(executions): implement executions module X1-X7
