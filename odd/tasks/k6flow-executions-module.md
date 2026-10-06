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
- [ ] Máquina de estados completa (QUEUED→STARTING→RUNNING→STOPPING→terminal)
- [ ] Tabla run_events para auditoría de transiciones
- [ ] Preflight básico (validación escenario, capacidad)
- [ ] Detención ordenada y forzada
- [ ] Resultado final por código de salida + umbrales

### X2 — Pipeline de métricas
- [ ] t-digest para percentiles correctos
- [ ] Ring buffer en memoria
- [ ] Eventos WS: hello, snapshot, tick, state, end
- [ ] Persistencia de series (run_series)
- [ ] Reconexión con lastSeq

### X3 — Vista en vivo mejorada
- [ ] 4 KPIs con sparklines
- [ ] 2 gráficas uPlot (RPS, Latencia)
- [ ] Modo seguir/explorar
- [ ] Estados de conexión visibles
- [ ] Banner de alertas

### X4 — Endpoints, fallos y logs
- [ ] Tabla métricas por endpoint
- [ ] Agrupación de fallos (endpoint × status × error_code)
- [ ] Muestreo de ejemplos (max 20 por grupo)
- [ ] Flujo de logs con backpressure
- [ ] Recursos del contenedor (CPU/mem)

### X5 — Lista y lanzamiento global
- [ ] Canal `/ws/runs` para resumen de activas
- [ ] Página /executions con pestañas En curso/En cola
- [ ] Contador en sidebar
- [ ] Asistente "Nueva prueba" con preflight completo
- [ ] Encolado si excede límite

### X6 — Historial y comparación
- [ ] Listado con filtros y paginación cursor
- [ ] Detalle finalizado con zoom de rango
- [ ] Comparación 2-4 ejecuciones
- [ ] Línea base y detección de regresión
- [ ] Exportación HTML/CSV/JSON

### X7 — Control avanzado
- [ ] Detención de emergencia global
- [ ] Auto-detención por saturación
- [ ] Notificaciones (campana)
- [ ] Límites duros en orquestador
- [ ] Auditoría completa

## Commits
- (pendiente) feat(executions): implementación módulo de ejecuciones X1-X7
