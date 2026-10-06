# K6Flow — Prompt complementario: Módulo de Ejecuciones (listar, lanzar, ver en vivo e historial)

> **Cómo usar este documento.** Complementa el prompt de inicialización original y los complementos de _grabación/biblioteca_ y _editor visual_. Para todo lo relacionado con **ejecuciones de carga** (lanzarlas, listarlas, verlas en vivo, consultar el historial, compararlas), **este documento prevalece**. Conserva las decisiones ya tomadas: Next.js, orquestador en Go, K6 en contenedores Docker (uno por prueba) sobre un VPS, REST para control, WebSocket para métricas en vivo, monorepo.
>
> **Referencia visual:** se adjunta una captura (mockup) de la pantalla de una ejecución en vivo: barra lateral con _Inicio · Escenarios · Grabaciones · Ejecuciones (con contador) · Historial · Configuración_, barra superior con buscador global y botón **"Nueva prueba"**, cabecera de la ejecución con estado EN VIVO y controles, tarjetas KPI, dos gráficas grandes, tabla por endpoint y registro de fallos/checks en streaming. Úsala como guía de **layout, jerarquía y estilo** (oscuro, acento violeta, datos en cian, tipografía monoespaciada para cifras). **Ojo:** el mockup contiene detalles que no corresponden a nuestra arquitectura; se corrigen en la sección 1.
>
> Los puntos **[DECISIÓN ABIERTA]** (sección 15) se preguntan antes de implementarse.

---

## 0. Objetivo

Un módulo de Ejecuciones completo y consistente que permita, desde el menú general de la aplicación:

1. **Lanzar** una ejecución desde cualquier lugar (botón global, lista de escenarios, detalle de escenario, historial).
2. **Listar y monitorear** todas las ejecuciones **en curso** (y en cola) en tiempo real.
3. **Ver en detalle y en vivo** una ejecución: métricas, gráficas, endpoints, fallos, recursos del generador de carga, y **controlarla** (pausar si es viable, detener, detención de emergencia).
4. **Consultar el historial**, filtrar, comparar ejecuciones, marcar líneas base, exportar reportes y **volver a lanzar** con la misma configuración.

**Regla de oro (definición de "hecho"):** ningún control, tarjeta, columna o botón se muestra si no tiene datos o comportamiento real detrás. Lo que no pueda calcularse con datos reales de K6 o del orquestador se oculta o se marca explícitamente como no disponible; **nunca se muestran cifras decorativas** como las del mockup.

---

## 1. Ajustes necesarios respecto al mockup

| Elemento del mockup                                                 | Problema                                                                                          | Qué implementar                                                                                                                                          |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Telemetría conectada (gRPC 24ms)"                                  | Decidimos REST + WebSocket, no gRPC.                                                              | Indicador de **estado de conexión del stream** (conectado / reconectando / datos atrasados), con latencia del heartbeat WS y antigüedad del último dato. |
| "Cluster k8s-eu-west-1", "Pods de inyección", "Pod #84"             | No usamos Kubernetes.                                                                             | **Recursos del contenedor K6** (CPU, memoria, red) obtenidos del Docker Engine; nombre del contenedor/nodo del VPS.                                      |
| "k6-core v0.49.1", "v2.4.0-cloud"                                   | Versiones de ejemplo.                                                                             | Mostrar la **versión real de K6** fijada en la imagen y la versión de K6Flow; sin la palabra "cloud".                                                    |
| "Jitter de red", "TCP conexiones reutilizadas", "Tiempo de bloqueo" | No son métricas nativas directas de K6.                                                           | Mostrar solo si se pueden **derivar** de métricas reales (ver sección 5.4) y rotularlas como derivadas; si no, ocultar.                                  |
| Botón **Pausar**                                                    | La pausa depende de la API REST de control de K6 y no es igual de fiable en todos los ejecutores. | Implementar solo si se **verifica** con pruebas por ejecutor (sección 7.2); si no es fiable, ocultar el botón.                                           |
| Contador "3" junto a _Ejecuciones_                                  | Correcto como idea.                                                                               | Contador real de ejecuciones activas (en curso + en cola), actualizado por WebSocket.                                                                    |
| Región, SLO "< 14 fallos", umbrales                                 | Valores de ejemplo.                                                                               | Provienen de los **umbrales (thresholds) configurados** en el escenario/ejecución.                                                                       |

---

## 2. Arquitectura de información (menú general)

- **Inicio:** resumen operativo: ejecuciones activas (tarjetas compactas), últimas finalizadas con su resultado, alertas recientes y accesos rápidos (Nueva prueba, Último escenario editado).
- **Escenarios:** biblioteca (ya definida); desde cada fila/detalle hay acción **Ejecutar**.
- **Grabaciones:** ya definida.
- **Ejecuciones:** vista de **lo activo**: pestañas **En curso** · **En cola** (sección 4). Insignia con el contador de activas.
- **Historial:** todas las ejecuciones finalizadas (sección 9).
- **Configuración:** incluye límites de concurrencia, retención, umbrales por defecto, notificaciones.
- **Barra superior global:** buscador (`/` o `Ctrl/Cmd+K`) sobre escenarios, ejecuciones (por nombre, ID, etiqueta), grabaciones; botón primario **"Nueva prueba"** siempre visible; campana de notificaciones (ejecución terminada, umbral incumplido, error de infraestructura); menú de usuario.
- **Detención de emergencia:** acción global accesible (menú de la barra superior y página Ejecuciones) que detiene **todas** las ejecuciones activas tras confirmación (sección 7.3).

---

## 3. Lanzar una ejecución ("Nueva prueba")

### 3.1 Puntos de entrada

Botón global **Nueva prueba** · acción **Ejecutar** en la fila/detalle de un escenario · desde el editor (botón ▶ Ejecutar carga) · en el Historial: **Volver a ejecutar** (misma configuración) y **Clonar configuración** (abrir el asistente precargado para modificar).

### 3.2 Asistente de lanzamiento (modal o página con pasos; un solo flujo reutilizado)

1. **Escenario y versión:** buscador de escenarios; versión por defecto = la actual; se puede fijar otra. Muestra resumen (nodos, hash del script, último resultado).
2. **Entorno y datos:** Environment (base URL, variables), Dataset y versión, política del pool (reciclar/abortar al agotarse).
3. **Perfil de carga:** preset (_Smoke, Load, Stress, Spike, Soak, Breakpoint_) o el perfil guardado en el escenario; ejecutor, etapas (stages), VUs/tasa, duración, con **vista previa gráfica** del perfil y duración total.
4. **Umbrales y metas (SLO):** tabla editable (métrica, agregación, operador, valor, abortar al incumplir) precargada con la del escenario.
5. **Identificación:** nombre de la ejecución (sugerido: `{escenario} {preset} {fecha}`), etiquetas, notas, ¿marcar como línea base?
6. **Verificación previa (preflight)** — llamada `POST /runs/preflight` con resultado visible:
   - Validación del escenario (errores bloquean, advertencias no).
   - **Destino y allowlist/SSRF:** muestra el/los hosts reales a los que se enviará carga y exige **confirmación explícita** (checkbox o escribir el host) la primera vez que se golpea un destino nuevo; bloquea destinos fuera de la lista permitida.
   - **Capacidad del VPS:** estimación de CPU/RAM del contenedor según VUs/tasa frente a recursos libres y ejecuciones activas; advertencia o bloqueo si excede el umbral configurado.
   - **Límites de concurrencia:** máximo de ejecuciones simultáneas; si se supera, se ofrece **encolar**.
   - **Smoke run recomendado** si el escenario cambió desde el último smoke exitoso (con atajo "Hacer smoke ahora").
7. **Resumen y lanzar:** botón **Iniciar ahora** (o **Encolar** si no hay capacidad). La **programación diferida/recurrente** queda fuera de v1 (ver D6) pero el modelo de datos debe contemplar `scheduled_for`.

### 3.3 Comportamiento posterior

Al lanzar, se navega a la **vista en vivo** de la ejecución; el botón de lanzamiento se bloquea contra doble clic (idempotencia con `Idempotency-Key`). Si el aprovisionamiento falla, se muestra la causa y la ejecución queda en estado `ERRORED` con registro de eventos.

---

## 4. Lista de ejecuciones activas (menú "Ejecuciones")

### 4.1 Contenido

Vista de **tarjetas o tabla conmutables** (recordar preferencia del usuario). Cada ejecución activa muestra:

- Nombre, escenario y versión, ID (`run-…`), entorno, quién la lanzó, etiquetas.
- **Estado** con insignia: `EN COLA`, `INICIANDO`, `EN VIVO` (con subestado: `Rampa`, `Estable`, `Descenso`), `PAUSADA`, `DETENIENDO`.
- **Progreso:** tiempo transcurrido / total y barra; fase actual ("Fase 2 de 4").
- **KPIs en miniatura:** RPS actual, p95, tasa de error, VUs actuales/objetivo, con _sparklines_ de los últimos minutos.
- **Estado de umbrales:** conteo de umbrales OK / en riesgo / incumplidos.
- **Salud del generador:** indicador de CPU/memoria del contenedor K6 (verde/ámbar/rojo).
- Acciones: **Abrir**, **Detener** (con confirmación), **Pausar/Reanudar** (si está implementado).

### 4.2 Pestaña "En cola"

Orden de llegada, motivo de espera (capacidad, límite de concurrencia), posición, estimación de inicio; acciones: cancelar, subir/bajar prioridad (solo si D6 lo aprueba), iniciar ahora si hay capacidad.

### 4.3 Actualización en tiempo real de la lista

- Un único canal WebSocket **`/ws/runs`** para el **resumen de todas las ejecuciones activas** (no abrir un WS por tarjeta). Mensajes agregados a **1 Hz** como máximo por ejecución.
- Al cambiar de estado una ejecución (inicia, termina, falla) llega un evento inmediato y se actualizan **contador de la barra lateral**, lista y campana de notificaciones.
- Estado vacío con acción "Nueva prueba" y enlace al Historial.

---

## 5. Vista de ejecución en vivo (detalle)

Estructura (siguiendo el mockup, de arriba abajo):

### 5.1 Cabecera

- Insignia **EN VIVO** / estado, versión de K6, indicador de conexión del stream, título, ID, **fase actual** ("Fase 2 de 4: Rampa ascendente") y **VUs actuales / objetivo** de la etapa.
- **Tiempo transcurrido / total** con temporizador; estimación de fin.
- Controles: **Pausar/Reanudar** (si viable), **Descargar** (resultados parciales: CSV/JSON de la serie), **Detener prueba** (confirmación; ver 7).
- Banner de **alerta** cuando: un umbral se incumple, el generador está saturado, hay datos atrasados o la conexión se perdió.

Cómo se obtiene la fase: el orquestador calcula la etapa vigente y el **objetivo interpolado de VUs/tasa** a partir del perfil de carga y el tiempo transcurrido (no se lee de K6 directamente); se guarda el `stage_index` en cada tick.

### 5.2 Tarjetas KPI (4)

- **Peticiones por segundo:** valor actual (ventana móvil de ~5–10 s), tendencia vs. un minuto atrás, pico acumulado y base.
- **Latencia p95:** valor actual, umbral SLO configurado y **margen** hasta el umbral; estado "Saludable/En riesgo/Incumplido".
- **Tasa de errores:** `http_req_failed` en % y conteo `fallos / total`; meta SLO; _sparkline_.
- **Usuarios virtuales:** actuales / máximo del perfil, barra de progreso, recuento de "inicio / rampa / objetivo", y **uso de CPU/memoria del contenedor K6** (no de un clúster).

Define explícitamente en la UI y en la documentación si cada KPI es de **ventana móvil** o **acumulado de la ejecución**, y muéstralo en el subtítulo. No mezcles ambos sin rotularlos.

### 5.3 Gráficas principales (2)

1. **RPS y rendimiento de red:** serie _total de peticiones_ vs _exitosas_ (2xx/3xx), con área, eje de tiempo de la ejecución y punto "actual". Debajo, mini-métricas: **Bytes entrada/salida por segundo** (`data_received`/`data_sent`), conexiones, **handshake TLS promedio** (`http_req_tls_handshaking`).
2. **Latencia en tiempo real:** percentiles **p50, p90, p95, p99** como series, **línea horizontal de SLO** configurable, marcado del **pico de p99** y anotaciones (cambio de etapa, incumplimiento de umbral). Mini-métricas: **TTFB promedio** (`http_req_waiting`), tiempo de bloqueo (`http_req_blocked`) y "jitter" solo si se deriva (5.4).

Requisitos de las gráficas:

- Librería orientada a **alto rendimiento en tiempo real** (recomendada: **uPlot** o **Apache ECharts**; ver D2). Actualización incremental (no re-renderizar toda la serie).
- Modo **Seguir en vivo** (ventana deslizante, p. ej. últimos 5/15/30 min o todo) y modo **Explorar** (pausar el seguimiento, zoom y desplazamiento); botón "Volver a vivo".
- **Cursor sincronizado** (tooltip alineado) entre las dos gráficas.
- **Decimación** de datos (p. ej. LTTB) para ejecuciones largas; la resolución de almacenamiento y de visualización son independientes.
- Leyenda interactiva (ocultar/mostrar series), tooltips con valores exactos y unidades correctas (ms, req/s, MB/s).

### 5.4 Qué se calcula a partir de qué (mapa de métricas)

| Mostrar                                | Fuente real (K6)                                                                          | Nota                                                                                                      |
| -------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| RPS                                    | `http_reqs` (contador) → tasa por ventana                                                 | Total y exitosas (por tag `status` / `expected_response`).                                                |
| Latencia p50/p90/p95/p99               | `http_req_duration` (Trend)                                                               | **Ver 6.3: no promediar percentiles.**                                                                    |
| Tasa de error                          | `http_req_failed` (Rate)                                                                  | Conteo = fallos/total.                                                                                    |
| VUs                                    | `vus`, `vus_max`                                                                          | Objetivo desde el perfil de carga.                                                                        |
| Iteraciones y duración de iteración    | `iterations`, `iteration_duration`                                                        |                                                                                                           |
| Checks pasados/fallidos                | `checks` (Rate) con tag `check`                                                           | Desglose por nombre de check.                                                                             |
| Bytes in/out                           | `data_received`, `data_sent`                                                              | Tasa por segundo.                                                                                         |
| TLS, TTFB, bloqueo, conexión           | `http_req_tls_handshaking`, `http_req_waiting`, `http_req_blocked`, `http_req_connecting` |                                                                                                           |
| **Conexiones reutilizadas (derivada)** | Fracción de peticiones con `http_req_connecting == 0`                                     | Proxy; rotular "estimado".                                                                                |
| **Jitter (derivada)**                  | Desviación estándar de `http_req_duration` por ventana                                    | Rotular "variación de latencia", no "jitter de red".                                                      |
| **Iteraciones descartadas**            | `dropped_iterations`                                                                      | Clave en ejecutores de tasa de llegada: si crece, el generador o el SUT no da abasto. **Mostrar alerta.** |
| Recursos del generador                 | Docker Engine (stats del contenedor)                                                      | CPU %, memoria, red.                                                                                      |

### 5.5 Tabla "Métricas por endpoint"

- Una fila por **endpoint lógico** (agrupado por el tag `name` de la petición, definido en el nodo HTTP; evita explosión de cardinalidad por URLs con IDs).
- Columnas: Endpoint · Método · req/s · media · p95 · (opcional p99) · error % · **estado** (Saludable / Advertencia / Incumplido según umbrales por endpoint si existen).
- Ordenable, filtrable, con búsqueda; clic en fila ⇒ **detalle del endpoint** (series propias, distribución de códigos de estado, ejemplos de fallos).
- Nota al pie con el **umbral de alerta activo** y enlace a "Ver trazas" **solo si existe** (muestras de peticiones fallidas, sección 5.6); si no, oculto.

### 5.6 Registro de fallos y checks (streaming)

- Flujo continuo con **marca de tiempo**, **tipo** (`CHECK OK`, `CHECK FAIL`, `WARN`, `ERROR`, `METRIC`, `STREAM`/sistema), mensaje y **VU** cuando aplique. Los eventos provienen de: logs/consola de K6 (stdout/stderr del contenedor vía Docker), checks fallidos y eventos del orquestador (cambios de etapa, escalados, saturación).
- **Muestreo de fallos:** el orquestador agrupa los fallos por **(endpoint, código de estado, `error_code`)** con contador y conserva **N ejemplos** (p. ej. 20 por grupo) con petición/respuesta resumidas y redactadas; evita registrar cada fallo individual en cargas altas.
- Filtros (Todos / Errores / Advertencias / Checks), búsqueda, **autoscroll** con pausa al hacer scroll manual, **Copiar logs**, descarga, y contadores de **Errores / Aciertos**.
- **Backpressure:** si el volumen de logs excede un umbral, se **muestrea** y se informa en el propio flujo ("N mensajes omitidos"), nunca se satura el WebSocket.

---

## 6. Pipeline de métricas en vivo (orquestador en Go)

### 6.1 Flujo

K6 (contenedor) → salida **JSON** a un archivo/volumen o _pipe_ → **orquestador (Go)** lee en _streaming_ → **agregador** por ventanas de 1 s → **ring buffer** en memoria + persistencia → difusión por **WebSocket** (`/ws/runs/{id}` y resumen en `/ws/runs`). Los logs se leen con la API de Docker (`ContainerLogs` en modo _follow_). Los recursos con `ContainerStats`.

### 6.2 Contrato de eventos (WS `/ws/runs/{id}`), campo `t`

- `hello`: `{ runId, state, seq, serverTime, config resumida, stage plan }` al conectar.
- `snapshot`: serie reciente (últimos N minutos) para pintar el estado inicial **antes** de los ticks nuevos.
- `tick` (cada 1 s): `{ seq, t, stageIndex, vus, vusTarget, rps, rpsOk, errRate, p50, p90, p95, p99, avg, bytesIn, bytesOut, iterations, dropped, checksPass, checksFail }`.
- `endpoints` (cada 2–5 s): tabla agregada por endpoint.
- `failure_group` / `failure_sample`: grupos de fallos y ejemplos.
- `log`: lotes de líneas de log (con muestreo).
- `threshold`: estado de cada umbral (`ok|risk|breached`, valor actual).
- `resources`: CPU/mem/red del contenedor K6.
- `state`: transición de estado (con causa).
- `alert`: saturación del generador, datos atrasados, umbral incumplido, etc.
- `end`: resumen final (resultado, códigos de salida, enlaces).
- `ping/pong` para latencia y detección de _stale_.

Esquemas definidos **una sola vez** en `packages/shared` (validación en runtime en cliente y servidor).

### 6.3 Corrección estadística (obligatorio)

- **No promedies percentiles entre ventanas.** Para calcular p50/p90/p95/p99 acumulados y por ventana, usa **histogramas** (p. ej. HdrHistogram o t-digest en Go): un histograma por ventana de 1 s, **fusionables**. Los percentiles acumulados salen de fusionar histogramas, no de promediar valores.
- El agregador debe operar con **memoria acotada** aun en cargas muy altas: no almacenar cada punto crudo en memoria; agregar al vuelo.
- Documenta la precisión (cifras significativas del histograma) y el rango (latencias máx. soportadas).
- Pruebas: dataset sintético con percentiles conocidos ⇒ el agregador reproduce los valores dentro de la tolerancia declarada.

### 6.4 Reconexión y consistencia

- Patrón **snapshot + stream** con `seq` monótono. Al reconectar, el cliente envía `lastSeq`; el servidor reenvía los ticks faltantes del **ring buffer** o, si ya se descartaron, indica "usa REST" y el cliente consulta `GET /runs/{id}/series?from=…`.
- Reintentos con _backoff_ exponencial y **indicador visible** de "reconectando"; si no llegan datos en X segundos (p. ej. 5 s) se marca **"datos atrasados"** sin borrar lo ya pintado.
- Si el navegador se cierra, **la ejecución continúa** (es del orquestador, no del cliente); al volver, se retoma sin pérdida.

### 6.5 Persistencia de la serie

- Se guarda la serie agregada por segundo (y _rollups_ por 10 s/1 min para ejecuciones largas) en la base de datos o en archivos columnares comprimidos (ver D3); la salida cruda de K6 se conserva **comprimida y opcional**, con retención configurable.
- Al finalizar: cálculo definitivo del **resumen** (valores exactos acumulados), resultado de umbrales y snapshot inmutable de la configuración utilizada.

---

## 7. Control de la ejecución

### 7.1 Máquina de estados

```
SCHEDULED* ─► QUEUED ─► STARTING ─► RUNNING ◄─► PAUSED**
                 │          │          │
                 ▼          ▼          ▼
              CANCELED    ERRORED    STOPPING ─► COMPLETED   (todos los umbrales OK)
                                                ├► FAILED     (umbrales incumplidos)
                                                ├► ABORTED    (detenida por el usuario o por umbral con abortar)
                                                └► ERRORED    (fallo de infraestructura / script)
* fuera de v1   ** solo si se verifica soporte (7.2)
```

- Cada transición queda en `run_events` con timestamp, actor y causa. Transiciones inválidas se rechazan (con pruebas).
- El resultado final se determina combinando el **código de salida de K6** (hay códigos específicos, entre ellos el de umbrales incumplidos — **verifica la tabla de códigos de la versión de K6 fijada**), el estado de umbrales y si hubo detención manual.

### 7.2 Pausar / Reanudar

La API REST de control de K6 (habilitada con `--address` dentro del contenedor y **accesible solo por la red interna del orquestador**) permite pausar y reanudar. **Verifica con pruebas de integración por ejecutor** (`constant-vus`, `ramping-vus`, arrival-rate…) cuál es el comportamiento real y qué ocurre con el tiempo transcurrido y las etapas. Si algún ejecutor no se comporta de forma fiable, **oculta el botón** para ese caso y documenta la limitación. La interfaz debe reflejar con claridad el estado `PAUSADA` y que el reloj de la prueba se detiene o no, según lo verificado.

### 7.3 Detener y detención de emergencia

- **Detener:** diálogo de confirmación; primero intento **ordenado** (señal/API para terminar y conservar los resultados parciales y el resumen); si no responde en N segundos, **forzar** el apagado del contenedor. El resultado queda `ABORTED` con datos parciales consultables.
- **Detención de emergencia global:** detiene **todas** las ejecuciones activas y vacía la cola (confirmación reforzada). Se registra en `audit_log`.
- **Abortar por umbral:** si un umbral está configurado con "abortar al incumplir", el estado final y la causa deben reflejarlo con claridad.
- **Protecciones del generador:** si la CPU/memoria del contenedor K6 supera un límite configurable durante X segundos, mostrar **alerta de saturación** (los resultados dejan de ser fiables) y, si se configuró, **detener automáticamente**.
- **Límites duros:** duración máxima, VUs máximos, tasa máxima, por proyecto/usuario, aplicados **en el orquestador** (no solo en la UI).

### 7.4 Notificaciones

Evento → campana de la app (y opcionalmente correo o _webhook_ en una iteración posterior, ver D6): ejecución finalizada, fallida, abortada, umbral incumplido, saturación detectada, error de infraestructura.

---

## 8. Detalle de una ejecución finalizada

Misma estructura visual que la vista en vivo (reutilizar componentes), pero estática y con pestañas:

- **Resumen:** resultado (✓ Aprobada / ✗ Umbrales incumplidos / Abortada / Error), duración, VUs pico, total de peticiones, RPS medio y pico, latencias p50/p90/p95/p99/máx, tasa de error, datos transferidos, iteraciones, checks.
- **Umbrales:** tabla con cada umbral, valor final, resultado y momento del primer incumplimiento.
- **Gráficas:** igual que en vivo, con **zoom y selección de rango** que recalcula el resumen del rango seleccionado.
- **Endpoints:** tabla completa y detalle por endpoint.
- **Errores:** grupos de fallos (endpoint × estado × código de error), conteos y ejemplos.
- **Registros:** logs consultables y descargables con filtros.
- **Configuración usada (inmutable):** versión del escenario + hash del script, entorno, dataset y versión, perfil de carga, umbrales, versión de K6/imagen, límites de recursos. Enlaces a la versión exacta del escenario.
- **Recursos del generador:** CPU/memoria durante la ejecución (para validar que el generador no fue el cuello de botella).
- **Acciones:** Volver a ejecutar · Clonar configuración · Marcar/quitar línea base · Comparar · Exportar · Editar nombre/notas/etiquetas · Eliminar (según retención).

---

## 9. Historial

### 9.1 Listado

Tabla con **filtros combinables y búsqueda**: rango de fechas, escenario (y versión), estado/resultado, entorno, usuario, etiquetas, "solo líneas base", rango de métricas (p95 > X, error > Y). Columnas configurables: nombre, escenario/versión, estado, inicio, duración, VUs pico, RPS medio, p95, tasa de error, umbrales (✓/✗), lanzado por, etiquetas. **Paginación por cursor**, ordenamiento, selección múltiple.

### 9.2 Comparación

- Seleccionar **2 a 4** ejecuciones ⇒ vista comparativa: tabla lado a lado (métricas clave y diferencia porcentual con color semántico), **gráficas superpuestas** (con alineación por tiempo relativo desde el inicio) y diferencias de configuración (versión del escenario, perfil de carga, entorno).
- **Línea base:** una ejecución marcada como base por escenario; cada nueva ejecución del mismo escenario muestra su desviación frente a la base y alerta de **regresión** si supera tolerancias configurables.
- Advertir cuando se comparen ejecuciones con **configuraciones no equivalentes** (otra versión de script, otro perfil de carga, otro entorno).

### 9.3 Tendencias por escenario

Gráfica de **p95, tasa de error y RPS por ejecución a lo largo del tiempo** (cada punto = una ejecución), para ver degradación o mejora entre despliegues.

### 9.4 Exportación

CSV/JSON de series y resumen, **reporte HTML autocontenido** (resumen, umbrales, gráficas, tablas, configuración) y PDF a partir de ese reporte. Enlace de **solo lectura** compartible (con expiración) como extensión (ver D6).

### 9.5 Retención

Política por proyecto: resolución completa de la serie por N días, _rollups_ por M días, resumen y configuración **sin caducidad**; las líneas base **no se purgan**. Borrado en cascada controlado y registrado en `audit_log`.

---

## 10. Modelo de datos (adiciones sobre el esquema existente de `runs`)

```sql
runs(                       -- ampliación
  id, project_id, scenario_id, scenario_version_id, name, notes,
  environment_id, dataset_version_id NULL,
  state, result,                       -- passed|thresholds_failed|aborted|errored
  load_config_json, thresholds_json,   -- snapshot inmutable
  k6_version, image_ref, script_hash,
  container_id, node_host,
  triggered_by, queued_at, scheduled_for NULL,
  started_at, ended_at, duration_ms,
  exit_code, abort_reason NULL,
  is_baseline BOOLEAN, summary_json)

run_events(id, run_id, at, from_state, to_state, actor, cause, detail_json)

run_series(run_id, t_sec, stage_index, vus, vus_target, rps, rps_ok, err_rate,
           p50, p90, p95, p99, avg, max, bytes_in, bytes_out,
           iterations, dropped, checks_pass, checks_fail)       -- 1 s
run_series_rollup(run_id, resolution_sec, t_sec, ... mismos campos con histogramas fusionados o agregados)

run_latency_hist(run_id, t_sec, hist_blob)        -- opcional: para recalcular rangos con precisión

run_endpoint_stats(run_id, endpoint_name, method, t_sec NULL, reqs, avg, p95, p99, err_rate, status_dist_json)
run_failure_groups(id, run_id, endpoint_name, status, error_code, count, first_at, last_at)
run_failure_samples(id, group_id, at, vu, request_summary_json, response_summary_json)  -- redactado
run_threshold_results(run_id, threshold_id, metric, agg, op, value, final_value, result, first_breach_at)
run_resources(run_id, t_sec, cpu_pct, mem_bytes, net_rx, net_tx)
run_logs_ref(run_id, uri, size_bytes)             -- logs completos en archivo comprimido
run_tags(run_id, tag)
notifications(id, user_id, kind, run_id, created_at, read_at, payload_json)
```

Índices por `(scenario_id, started_at DESC)`, `(state)`, `(project_id, started_at DESC)`, y por etiquetas. Series y logs de gran tamaño fuera de las tablas transaccionales si el volumen lo exige (D3).

---

## 11. API REST (bajo `/api/v1`)

```
POST   /runs/preflight                 # valida lanzamiento: escenario, destino, capacidad, límites
POST   /runs                           # lanza (Idempotency-Key) → { runId, state, wsUrl, token }
GET    /runs?state=&scenario=&q=&tag=&from=&to=&result=&sort=&cursor=&limit=
GET    /runs/active                    # activas + en cola (snapshot para la lista)
GET    /runs/{id}
PATCH  /runs/{id}                      # nombre, notas, etiquetas, línea base
DELETE /runs/{id}

POST   /runs/{id}/stop                 # ordenado, luego forzado
POST   /runs/{id}/pause   |   /resume  # solo si D4 confirma soporte
POST   /runs/{id}/cancel               # si está en cola
POST   /runs/emergency-stop            # confirmación reforzada, auditado

GET    /runs/{id}/series?metrics=&from=&to=&resolution=
GET    /runs/{id}/endpoints
GET    /runs/{id}/failures?group=&cursor=
GET    /runs/{id}/logs?cursor=&level=&q=
GET    /runs/{id}/thresholds
GET    /runs/{id}/resources
GET    /runs/{id}/config                # snapshot inmutable
GET    /runs/{id}/export?format=csv|json|html|pdf

POST   /runs/{id}/rerun                # misma configuración
POST   /runs/{id}/clone-config         # devuelve borrador para el asistente
POST   /runs/compare                   # { ids: [...] } → comparación calculada
GET    /scenarios/{id}/runs/trend      # serie por ejecución para tendencias
GET    /notifications ; POST /notifications/{id}/read
```

Autorización por proyecto en todos; errores con formato uniforme (`code`, `message`, `details`); paginación por **cursor**; `Idempotency-Key` en `POST /runs`.

---

## 12. Seguridad y límites (específicos de este módulo)

- **Destinos:** misma **allowlist anti-SSRF** y confirmación del destino que el resto de la herramienta; verificada en el **orquestador** al lanzar (no solo en la UI), incluyendo resolución DNS y rangos privados/metadatos bloqueados para el contenedor K6.
- **Contenedores K6:** usuario sin privilegios, `cap-drop=ALL`, límites de CPU/memoria/PIDs/duración, red dedicada sin acceso a servicios internos, API REST de K6 expuesta **solo** a la red interna del orquestador (nunca publicada).
- **Secretos:** variables de Environment por referencia; **enmascarados** en UI, logs, muestras de fallos y exportaciones; no escritos en el script ni en el snapshot de configuración.
- **Redacción** de cuerpos/headers en muestras de fallos (configurable); **retención** y borrado auditados.
- **Autorización:** permisos para lanzar, detener, detener todo y eliminar (roles); **auditoría** de lanzamientos, paradas y emergencia.
- **Límites** de ejecuciones concurrentes, VUs, tasa y duración por usuario/proyecto; protección contra uso del VPS como herramienta de ataque (las mismas reglas de destino y topes).
- **WebSocket:** tokens efímeros ligados a usuario/proyecto, verificación de `Origin`, límite de conexiones por usuario, ratelimit de mensajes de control.

---

## 13. Lineamientos de UI/UX y rendimiento

- **Estilo** según la referencia: tema oscuro (con claro opcional), acento violeta para acciones primarias, cian para datos positivos/en vivo, ámbar/rojo semánticos para advertencia/error, **cifras en tipografía monoespaciada** con unidades, tarjetas con jerarquía clara. Interfaz en español (Colombia).
- **Estados completos de cada vista:** cargando (skeletons), vacío, error, desconectado, datos atrasados, sin permisos.
- **Responsive:** la vista en vivo debe funcionar en pantallas de portátil; en móvil, orden vertical con KPIs y gráficas apiladas (prioridad: estado, KPIs, controles).
- **Rendimiento:** actualizar solo lo que cambia (selectores finos en el store), gráficas con _canvas_, tablas virtualizadas en logs y listas largas, objetivo de fluidez con **10 ejecuciones activas** simultáneas en la lista y logs a alta frecuencia. Mide con una prueba de rendimiento automatizada.
- **Accesibilidad:** estados no comunicados solo por color, foco visible, navegación por teclado, `aria-live` moderado para alertas críticas (sin inundar al lector de pantalla con cada tick).
- **Atajos:** `N` nueva prueba · `/` buscar · `G` luego `E`/`H` ir a Ejecuciones/Historial · `S` detener (con confirmación) en la vista en vivo.

---

## 14. Plan de implementación por fases (con criterios de aceptación)

**X1 — Ciclo de vida mínimo.** Modelo `runs`/`run_events`, máquina de estados, lanzamiento con preflight básico, contenedor K6 con salida JSON, detención ordenada y forzada, resultado final por código de salida.
_Aceptación:_ lanzar y detener una ejecución real; estado y resultado correctos tras finalizar, abortar y fallar el script (con pruebas).

**X2 — Pipeline de métricas.** Lectura en streaming, agregador con **histogramas**, ring buffer, WS `/ws/runs/{id}` con `hello/snapshot/tick/state/end`, persistencia de series.
_Aceptación:_ test con dataset sintético reproduce percentiles conocidos dentro de la tolerancia; reconexión del cliente sin huecos; la ejecución sobrevive al cierre del navegador.

**X3 — Vista en vivo.** Cabecera, 4 KPIs, 2 gráficas (modo seguir/explorar), estados de conexión, controles de detener.
_Aceptación:_ una ejecución real se ve fluida, coherente con los números del resumen final de K6 (tolerancia declarada) y sin cifras decorativas.

**X4 — Endpoints, fallos y logs.** Tabla por endpoint, agrupación y muestreo de fallos, flujo de logs con filtros/backpressure, recursos del contenedor, alertas de saturación y `dropped_iterations`.
_Aceptación:_ provocar errores controlados en `fixtures/test-server` y verlos agrupados con ejemplos redactados; saturar el generador y ver la alerta.

**X5 — Lista y lanzamiento global.** Canal `/ws/runs`, pestañas En curso/En cola, contador del menú, asistente "Nueva prueba" con preflight completo (destino, capacidad, límites), encolado.
_Aceptación:_ lanzar 3 ejecuciones simultáneas desde distintos puntos de entrada; la lista y el contador se actualizan en vivo; la cuarta se encola según el límite configurado.

**X6 — Historial, comparación y reportes.** Listado con filtros y cursor, detalle finalizado con selección de rango, comparación de 2–4, línea base y regresión, tendencias, exportación HTML/CSV/JSON/PDF, retención.
_Aceptación:_ comparar dos ejecuciones con aviso de configuraciones no equivalentes; reporte HTML autocontenido abre sin conexión.

**X7 — Control avanzado y endurecimiento.** Pausa/reanudación (solo si se verifica), detención de emergencia, auto-detención por saturación, notificaciones, auditoría, límites duros en el orquestador, recolector de contenedores huérfanos, pruebas de concurrencia.
_Aceptación:_ tras fallos simulados (caída del orquestador, del WS, del contenedor) no quedan contenedores huérfanos ni estados inconsistentes.

**Pruebas transversales:** unitarias (agregador, máquina de estados, cálculo de fase/objetivo), integración con K6 real contra `fixtures/test-server`, e2e con Playwright (lanzar → ver en vivo → detener → historial → comparar), pruebas de reconexión y de carga del propio pipeline.

---

## 15. Decisiones abiertas — pregúntame antes de implementarlas

- **D1. Fuente de métricas de K6:** salida **JSON** parseada por el orquestador (propuesta actual) frente a otras salidas (p. ej. _remote write_/StatsD/API REST de K6). Recomiéndame con tus argumentos y costos de rendimiento.
- **D2. Librería de gráficas:** uPlot (máximo rendimiento, más trabajo de UI) frente a Apache ECharts (más completa) frente a Recharts (sencilla, menos apta para tiempo real intenso).
- **D3. Almacenamiento de series e histogramas:** tablas en la BD elegida (Postgres/SQLite) frente a archivos columnares/comprimidos por ejecución; política de _rollups_ y tamaños esperados.
- **D4. Pausa/reanudación:** si la verificación por ejecutor muestra soporte parcial, ¿ocultar el botón del todo o habilitarlo solo en ejecutores soportados?
- **D5. Percentiles:** HdrHistogram vs t-digest (precisión, tamaño de blobs, fusión), y si se guardan histogramas por segundo para recalcular rangos exactos en el historial.
- **D6. Alcance posterior a v1:** programación diferida/recurrente, prioridades de cola, notificaciones por correo/webhook, enlaces de solo lectura compartibles, integración con CI (lanzar y esperar resultado por API).
- **D7. Traza de peticiones ("Ver trazas distribuidas" del mockup):** ¿se ofrece una vista de **muestras de peticiones fallidas/lentas** (propuesto) o se omite en v1? Las "trazas distribuidas" reales (OpenTelemetry) quedan fuera salvo decisión contraria.

---

## 16. Entregables esperados en el repositorio

- `docs/runs.md` (ciclo de vida, estados y códigos de salida), `docs/live-metrics.md` (pipeline, agregación, protocolo WS, reconexión), `docs/metrics-map.md` (tabla métrica → fuente → fórmula), `docs/run-limits-and-security.md`, `docs/history-and-retention.md`.
- `fixtures/test-server/` ampliado (latencias configurables, errores 4xx/5xx controlados, endpoints lentos) y escenarios de referencia para pruebas.
- Migraciones de BD versionadas y OpenAPI de `/runs`.

---

## 17. Reglas de trabajo para ti (el agente)

1. Antes de escribir código, resume en pocas líneas lo que entendiste y lista las decisiones abiertas con tu recomendación.
2. Trabaja por fases X1→X7; al cerrar cada una, ejecuta las pruebas y reporta qué criterios de aceptación se cumplen y cuáles no, con evidencia.
3. **No muestres datos que no existan**: toda cifra de la UI tiene fuente real o se oculta; el mockup es referencia visual, no de datos.
4. Mantén los contratos (WS, REST, esquema de eventos) definidos **una sola vez** en `packages/shared` y validados en ambos extremos.
5. No amplíes el alcance sin consultarme; lo marcado como posterior a v1 se diseña como extensible, no se implementa.
6. Ante ambigüedades que afecten seguridad, exactitud estadística o el modelo de datos, **pregunta**; en lo demás, decide, documenta en `docs/` y continúa.
