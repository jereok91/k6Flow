# K6Flow — Prompt complementario: Grabación, Streaming del navegador remoto y Biblioteca de pruebas

> **Cómo usar este documento.** Es un complemento del prompt de inicialización original de K6Flow (monorepo: `apps/web`, `apps/orchestrator` en Go, `apps/recorder` en Node, `packages/shared`). Donde este documento sea más específico que el original, **este prevalece** para todo lo relacionado con grabación, streaming y biblioteca. Donde choque con una decisión ya tomada (Go para el orquestador, REST para control, WebSocket para streaming y métricas en vivo), **conserva la decisión original** y avísame del conflicto antes de seguir.
>
> No improvises en los puntos marcados como **[DECISIÓN ABIERTA]** (sección 14): pregúntame con una recomendación razonada y espera mi respuesta.

---

## 0. Problemas que este complemento resuelve

1. **Streaming insuficientemente especificado.** Falta definir cómo se retransmite el navegador headless del `recorder` hacia la UI para que la persona vea y controle, en un "mini navegador" embebido, cada acción que ejecuta mientras graba.
2. **Sin biblioteca.** Hoy no hay forma de listar, identificar, buscar, reutilizar ni retomar escenarios, grabaciones y ejecuciones. Cada grabación es un callejón sin salida.
3. **La grabación es un acto pasivo.** El usuario "solo graba" y no hay un modelo de qué significa esa grabación, qué se conserva de ella, cómo se anota y cómo se reutiliza después.

El resultado esperado es que **una grabación sea un activo durable, inmutable y reprocesable**, y que de ella deriven escenarios versionados, reutilizables y ejecutables repetidamente.

---

## 1. Modelo conceptual y glosario (obligatorio respetar los nombres)

| Entidad                            | Definición                                                                                                                                                | Mutabilidad                                                                                         |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Recording** (Grabación)          | Registro crudo y completo de una sesión de navegación: eventos de UI, tráfico de red, marcadores de pasos y metadatos. Es la **fuente de verdad**.        | **Inmutable** una vez cerrada (solo se puede anotar con metadatos, nunca alterar la captura cruda). |
| **RecordingSession**               | Vida operativa de un contenedor `recorder` (aprovisionamiento → streaming → apagado). Una Recording nace de una RecordingSession.                         | Efímera; se destruye al terminar.                                                                   |
| **Step** (Paso)                    | Segmento lógico de una Recording delimitado por marcadores que pone el usuario (o por heurística). Agrupa acciones de UI y las peticiones que provocaron. | Editable _sobre la derivación_, no sobre la captura cruda.                                          |
| **UIEvent**                        | Acción del usuario en el navegador remoto (clic, tecleo, scroll, navegación).                                                                             | Inmutable.                                                                                          |
| **CapturedRequest**                | Petición/respuesta HTTP capturada, con tiempos, headers y cuerpos.                                                                                        | Inmutable (con redacción aplicada al persistir, ver sección 10).                                    |
| **Scenario** (Escenario)           | Objeto de biblioteca: grafo de nodos ejecutable. Tiene identidad estable y múltiples versiones.                                                           | Cada versión es inmutable.                                                                          |
| **ScenarioVersion**                | Snapshot inmutable de un grafo + parámetros + script K6 generado + hash.                                                                                  | **Inmutable.**                                                                                      |
| **Fragment** (Módulo reutilizable) | Sub-grafo con interfaz (entradas/salidas) que puede insertarse en varios escenarios, p. ej. "Login", "Añadir al carrito".                                 | Versionado igual que Scenario.                                                                      |
| **Dataset**                        | Pool de datos (CSV de usuarios, IDs, etc.) reutilizable entre escenarios.                                                                                 | Versionado.                                                                                         |
| **Run** (Ejecución)                | Una ejecución K6 en un contenedor, ligada a **una ScenarioVersion exacta** y a una configuración de carga y entorno.                                      | Inmutable tras finalizar.                                                                           |
| **Environment**                    | Conjunto de variables (base URL, headers, credenciales por referencia) que se inyecta al ejecutar.                                                        | Versionado.                                                                                         |

**Principio rector:** `Recording` (crudo, inmutable) → _pipeline determinista_ → `ScenarioVersion` (derivado, versionado) → `Run` (reproducible). Se puede **reprocesar la misma Recording** con reglas nuevas para generar una nueva versión sin volver a grabar.

---

## 2. Ciclo de vida de una grabación (máquina de estados)

```
CREATED ──► PROVISIONING ──► READY ──► RECORDING ◄──► PAUSED
                │               │          │
                ▼               ▼          ▼
             FAILED          EXPIRED     STOPPING ──► PROCESSING ──► REVIEW ──► SAVED
                                                          │                       │
                                                          ▼                       ▼
                                                       FAILED                 DISCARDED
```

- `CREATED`: el usuario pulsa "Nueva grabación" e indica URL inicial, entorno y (opcional) escenario base o `storageState` desde el cual retomar.
- `PROVISIONING`: el orquestador (Go) crea el contenedor `recorder` con límites de CPU/memoria/tiempo y red restringida; responde con `recordingId` y un **token efímero** para el WebSocket.
- `READY`: navegador lanzado, primer frame transmitido; la UI muestra el mini navegador. Aún no se registra nada.
- `RECORDING`: se capturan UIEvents y tráfico de red. El usuario puede **pausar** (`PAUSED`): el navegador sigue visible y usable, pero **no se registra** (útil para pasos de preparación que no deben formar parte de la prueba).
- `STOPPING`: se cierra el screencast, se vacían buffers, se persiste la captura cruda.
- `PROCESSING`: corre el pipeline de transformación (sección 6) de forma asíncrona.
- `REVIEW`: el usuario revisa pasos, tráfico filtrado, valores detectados como dinámicos y parametrizaciones sugeridas, y confirma o ajusta.
- `SAVED`: se crea/actualiza el Scenario y su ScenarioVersion; la Recording queda vinculada como procedencia.
- `EXPIRED`: apagado por inactividad o duración máxima sin interacción; si había captura parcial, ofrecer recuperarla.
- Toda transición se registra con timestamp y causa. Las transiciones inválidas deben rechazarse (máquina de estados explícita, con tests).

---

## 3. Streaming del navegador remoto ("mini navegador" en la UI)

### 3.1 Objetivo funcional

El usuario ve en la interfaz un **navegador embebido** (viewport + barra de herramientas) que refleja en tiempo casi real el Chromium headless del contenedor `recorder`. Cualquier clic, tecleo o scroll que haga sobre ese viewport se ejecuta en el navegador remoto. Debe sentirse como navegar un sitio normal, con la diferencia de que cada acción queda registrada.

### 3.2 Decisión de transporte de vídeo (resumen)

| Opción                                                   | Ventajas                                                                                            | Desventajas                                                                                                                                                            | Veredicto                              |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| **CDP `Page.startScreencast` + WebSocket** (frames JPEG) | Simple, sin dependencias extra, mismo canal que ya existe, control total de calidad y backpressure. | No es vídeo real; no captura UI nativa del navegador (selects nativos, diálogos de archivo) de forma fiable; consume algo más de ancho de banda que un códec de vídeo. | **MVP recomendado.**                   |
| Xvfb + navegador _headful_ + noVNC/VNC                   | Captura todo lo visible, incluida UI nativa.                                                        | Contenedor más pesado, más superficie de ataque, latencia y complejidad de despliegue.                                                                                 | Plan B si CDP no cubre casos críticos. |
| WebRTC (captura de pantalla/tab → peer)                  | Mínima latencia, códec eficiente.                                                                   | Complejidad alta (señalización, TURN/STUN en VPS), difícil de depurar.                                                                                                 | Evolución futura.                      |

**Requisito de diseño:** define una interfaz `FrameSource` en el `recorder` (`start()`, `stop()`, `onFrame(cb)`, `setQuality(q)`) con la implementación CDP como primera. Así podemos cambiar a VNC o WebRTC sin tocar el protocolo hacia la UI.

### 3.3 Captura de frames con CDP

Usa una sesión CDP de Chromium (`context.newCDPSession(page)` en Playwright; solo funciona en Chromium, y eso es parte de por qué fijamos Chromium para el recorder).

- Arranque: `Page.startScreencast` con `format: 'jpeg'`, `quality` inicial 60, `maxWidth`/`maxHeight` acordes al viewport, `everyNthFrame: 1`.
- Cada frame llega por el evento `Page.screencastFrame` con `data` (base64), `sessionId` y `metadata` (`offsetTop`, `pageScaleFactor`, `deviceWidth`, `deviceHeight`, `scrollOffsetX`, `scrollOffsetY`, `timestamp`).
- **Obligatorio:** responder cada frame con `Page.screencastFrameAck({ sessionId })`. Si no se hace, Chrome deja de emitir.
- **Backpressure real:** no hagas `ack` inmediato si el WebSocket del cliente está saturado. Haz `ack` **solo cuando el frame se haya enviado** (o se haya descartado conscientemente). Si el buffer del socket (`bufferedAmount`) supera un umbral, descarta frames intermedios y quédate con el más reciente (política _latest-wins_). Prefiere latencia baja a fidelidad completa.
- **Calidad adaptativa:** mide el tiempo de envío/ack y el `bufferedAmount`; si empeora, baja `quality` y/o `maxWidth` en pasos; si mejora sostenidamente, sube. Límites duros: 5–15 fps efectivos, viewport por defecto 1280×720 configurable, calidad JPEG 40–80.
- **Viewport determinista:** fija `Emulation.setDeviceMetricsOverride` (ancho, alto, `deviceScaleFactor: 1`) y guarda ese viewport en la Recording; ejecutar un escenario derivado debe poder reproducir condiciones equivalentes (user agent, idioma, zona horaria, viewport).

### 3.4 Protocolo WebSocket recorder ⇄ UI

Canal: `GET /ws/recordings/{recordingId}?token=<efímero>` (directo al `recorder` o proxificado por `web`; **[DECISIÓN ABIERTA D3]**). Usa **mensajes binarios para frames** y **JSON para control**.

**Frame binario (servidor → cliente):**

```
offset  tamaño  campo
0       1       tipo = 0x01 (FRAME)
1       4       seq (uint32, big endian)
5       2       ancho del frame (uint16)
7       2       alto del frame (uint16)
9       8       timestamp del recorder en ms (uint64)
17      N       payload JPEG
```

**Mensajes JSON de control (ambos sentidos), campo `t` discriminante:**

Servidor → cliente:

- `{"t":"state","state":"RECORDING","recordingId":"..."}`
- `{"t":"nav","url":"...","title":"...","canGoBack":true,"canGoForward":false,"loading":false}`
- `{"t":"tabs","tabs":[{"id":"t1","url":"...","title":"...","active":true}]}`
- `{"t":"cursor","style":"pointer"}` (estilo CSS del cursor bajo el puntero, ver 3.6)
- `{"t":"dialog","kind":"confirm|alert|prompt|beforeunload","message":"...","id":"d1"}`
- `{"t":"filechooser","id":"f1","multiple":false}`
- `{"t":"stats","fps":9,"quality":55,"rttMs":38,"droppedFrames":2,"recordedRequests":143}`
- `{"t":"step","stepId":"s3","name":"Login","startedAt":...}`
- `{"t":"error","code":"...","message":"..."}`

Cliente → servidor:

- `{"t":"mouse","type":"move|down|up|wheel","x":412,"y":220,"button":"left","clickCount":1,"deltaX":0,"deltaY":120,"mods":0}`
- `{"t":"key","type":"down|up","key":"a","code":"KeyA","text":"a","vk":65,"mods":0}`
- `{"t":"text","text":"..."}` (entrada por IME/pegado; usa `Input.insertText`)
- `{"t":"nav","action":"goto|back|forward|reload|stop","url":"..."}`
- `{"t":"tab","action":"new|switch|close","id":"t1"}`
- `{"t":"dialog_reply","id":"d1","accept":true,"promptText":"..."}`
- `{"t":"file_upload","id":"f1","files":[{"name":"...","assetId":"..."}]}` (los archivos se suben antes por REST; nunca por este canal)
- `{"t":"resize","width":1280,"height":720}`
- `{"t":"mark","name":"Login","kind":"step|assert|note","note":"..."}` (ver sección 4)
- `{"t":"pause"}` / `{"t":"resume"}` / `{"t":"stop"}`
- `{"t":"ping","ts":...}` ⇄ `{"t":"pong","ts":...}` para medir RTT.

Define el esquema de estos mensajes **una sola vez** en `packages/shared` (TypeScript con validación en runtime, p. ej. zod) y reutilízalo en `web` y en `recorder`. Rechaza y registra cualquier mensaje que no valide.

### 3.5 Entrada del usuario → navegador remoto

- En el frontend, el viewport es un `<canvas>` (o `<img>` sobre capa de eventos). Captura `pointer*`, `wheel`, `keydown/keyup`, `paste`, `compositionstart/update/end` (IME).
- **Mapeo de coordenadas:** convierte la posición del puntero del elemento mostrado a coordenadas CSS del viewport remoto: `xRemoto = (xLocal / anchoMostrado) * anchoViewportRemoto`, e igual para Y. Ten en cuenta `devicePixelRatio` local, `object-fit`, bordes y el `offsetTop` del metadata del screencast. Escribe tests unitarios de esta función con varias relaciones de aspecto.
- **Inyección en CDP:** `Input.dispatchMouseEvent` (`mouseMoved`, `mousePressed`, `mouseReleased`, `mouseWheel`), `Input.dispatchKeyEvent` (`keyDown`, `keyUp`, `char`), `Input.insertText` para texto compuesto/pegado, y atajos de teclado con `modifiers` (bitmask Alt=1, Ctrl=2, Meta=4, Shift=8).
- **Throttling de `mousemove`:** muestrea a ~30–60 Hz en cliente, no envíes cada evento crudo. Los clics, teclas y rueda **nunca** se descartan ni se reordenan.
- **Orden y causalidad:** numera los mensajes de entrada (`seq`) y procésalos en orden estricto en el recorder.
- **Foco del teclado:** el viewport debe tomar foco al hacer clic y mostrar claramente si está capturando teclado; `Esc` o clic fuera lo libera. Atajos del propio K6Flow no deben colisionar con teclas que el usuario quiere enviar al sitio.
- **Portapapeles:** pegar desde el equipo local se hace explícitamente (evento `paste` → `text`); no se sincroniza portapapeles de forma bidireccional automática.

### 3.6 Barra del mini navegador y comportamientos que hay que cubrir

- **Barra de herramientas:** atrás, adelante, recargar/detener, **barra de direcciones editable**, indicador de carga, indicador de grabación (punto rojo con temporizador), botones Pausar/Reanudar/Detener, y botón **Marcar paso**.
- **Pestañas y ventanas emergentes:** escucha `Target.setAutoAttach`/eventos de página nueva (`context.on('page')`). Muestra pestañas en la barra; la que esté activa es la que se transmite. Los `window.open` y enlaces `target=_blank` deben aparecer como pestañas nuevas.
- **Diálogos JS** (`alert`, `confirm`, `prompt`, `beforeunload`): captura con `Page.javascriptDialogOpening`, muéstralos como modal en la UI y responde con `Page.handleJavaScriptDialog`. La decisión del usuario se registra como UIEvent.
- **Subida de archivos:** intercepta `Page.fileChooserOpened` (`Page.setInterceptFileChooserDialog`); la UI abre un selector local, sube el archivo por REST a un área temporal del recorder y se asigna al `input[type=file]`.
- **Selects nativos y otros controles del sistema:** pueden no aparecer en el screencast. **Verifica con pruebas reales** y, si falla, implementa un overlay propio (la UI recibe la lista de opciones y reenvía la selección) o activa el plan B (sección 3.2).
- **Cursor:** el screencast **no dibuja el cursor**. Dibuja un cursor superpuesto en el frontend con la posición local y el estilo recibido (`cursor`), obtenido inyectando un script ligero que lee `getComputedStyle(elementFromPoint).cursor` y lo notifica con `exposeBinding`.
- **Descargas:** intercepta eventos de descarga, regístralos como UIEvent y no los guardes salvo que el usuario lo pida.
- **iframes y shadow DOM:** el streaming es de píxeles, así que funcionan sin trabajo extra; la captura de selectores (sección 4.3) debe contemplar frames cruzados.
- **Reconexión:** si el WebSocket se cae brevemente, el recorder **mantiene la sesión X segundos** (configurable, 30 s por defecto) esperando reconexión con el mismo token; al volver, envía estado completo (`nav`, `tabs`, `stats`) y reanuda frames. Pasado el plazo, `STOPPING` ordenado y notificación al orquestador.
- **Espectadores:** soporta un controlador (escritura) y N espectadores de solo lectura con el mismo `recordingId` (útil para soporte/QA). Solo el controlador puede enviar entrada.

### 3.7 Objetivos de rendimiento y verificación

- Latencia de entrada→frame percibida: **< 250 ms en LAN/VPS cercano** como objetivo, medida con `ping`/`pong` y marcas en frames.
- Ancho de banda típico: documentar valores medidos para 720p a 8 fps con calidad 60.
- Pruebas obligatorias: sitio de pruebas propio y controlado (en el repo, `fixtures/test-site`) con formularios, redirecciones, popups, iframes, diálogos y subida de archivos, ejecutado en CI con el recorder real.

---

## 4. Anotación de la grabación: pasos, marcadores y semántica

El usuario no "solo graba": **estructura** lo que graba mientras navega.

### 4.1 Marcadores (`mark`)

- **Paso (`step`)**: abre un nuevo Step con nombre (p. ej. "Login", "Buscar producto", "Pagar"). Todo lo que ocurra desde ese marcador hasta el siguiente pertenece a ese paso. Si el usuario no marca nada, genera pasos automáticos por heurística (cambio de documento principal / navegación de primer nivel) con nombres provisionales editables.
- **Aserción (`assert`)**: el usuario marca "aquí debe verse esto": a partir de la última respuesta, selecciona un texto/elemento visible o un código de estado; se convierte más adelante en un nodo de Validación de respuesta.
- **Nota (`note`)**: texto libre asociado a un instante, sin efecto en la ejecución, útil para documentar.
- Cada marcador guarda: `id`, `kind`, `name`, `tOffsetMs` (relativo al inicio), `tabId` y URL vigente.

### 4.2 Registro de eventos de UI

Para cada acción del usuario guarda un `UIEvent` con:
`seq`, `tOffsetMs`, `tabId`, `type` (`click|dblclick|type|key|scroll|navigate|dialog|upload|select`), coordenadas, **selector del elemento destino** (cuando aplique) y valor tecleado (con redacción si el campo es sensible, sección 10).

### 4.3 Resolución de selectores

Aunque la entrada llegue por CDP como coordenadas, interesa saber **a qué elemento** se hizo clic. Inyecta con `context.addInitScript` un observador mínimo que, en la fase de captura (`capture: true`), registre para cada evento `click/input/change` un selector estable (prioridad: `data-testid` → `id` → `name` → `role+nombre accesible` → CSS corto → XPath como último recurso), más texto visible truncado, y lo reporte por `exposeBinding`. Soporta iframes y shadow DOM. Estos selectores **no se usan para la carga K6** (K6 trabaja a nivel de protocolo), pero sirven para: nombrar pasos, mostrar contexto en la revisión y habilitar una futura vía de prueba de navegador.

### 4.4 Correlación UI ↔ red

- Cada `CapturedRequest` guarda `tStartMs`, `tEndMs`, `frameId`, `loaderId`, `initiator` (tipo y stack resumido) y `redirectChain`.
- Asigna cada petición a un `Step` por ventana temporal y la vincula al `UIEvent` más probable que la causó (el último evento previo dentro de un umbral, con tolerancia configurable). Guarda también peticiones "huérfanas" (timers, polling) marcadas como tales.
- Captura vía dominio CDP `Network.*` (`requestWillBeSent`, `requestWillBeSentExtraInfo`, `responseReceived`, `responseReceivedExtraInfo`, `loadingFinished`, `getResponseBody`) para tener cookies y headers reales, no solo los que ve Playwright por defecto.

### 4.5 Alcance de la captura (v1)

- **Incluido:** HTTP/1.1 y HTTP/2 (XHR/fetch/documentos/formularios), redirecciones, cookies, cuerpos JSON/formulario/texto, multipart como metadato.
- **Fuera de alcance v1 (documentar y diseñar extensible):** WebSocket del sitio objetivo, gRPC-web con streaming, Server-Sent Events largos, WebRTC, descargas binarias grandes. Se registran como "eventos no soportados" visibles en la revisión para que el usuario sepa qué no quedó cubierto.

---

## 5. Modelo de datos y almacenamiento

Diseña el esquema con tipos portables (Postgres o SQLite según **D1**). Esquema de referencia (ajústalo, justificando cambios):

```sql
scenarios(
  id, project_id, name, description, status,         -- active|archived
  current_version_id, folder_id, is_favorite,
  created_by, created_at, updated_at, archived_at)

scenario_versions(
  id, scenario_id, version_number, graph_json,        -- IR de nodos (sección 6)
  k6_script, script_hash, params_json,
  derived_from_recording_id NULL, pipeline_version,
  rules_snapshot_json, note, created_by, created_at)  -- INMUTABLE

recordings(
  id, project_id, name, state, start_url,
  environment_id NULL, base_scenario_id NULL,
  resume_from_state_id NULL,                          -- storageState de origen
  viewport_json, user_agent, locale, timezone,
  started_at, ended_at, duration_ms,
  stats_json, raw_capture_uri, created_by)

recording_steps(
  id, recording_id, ordinal, name, kind,              -- step|auto
  t_start_ms, t_end_ms, note)

recording_marks(
  id, recording_id, step_id NULL, kind, name, t_offset_ms, tab_id, url, payload_json)

recording_ui_events(
  id, recording_id, step_id, seq, t_offset_ms, tab_id,
  type, x, y, selector, text_preview, payload_json)

captured_requests(
  id, recording_id, step_id, ui_event_id NULL, seq,
  method, url, status, t_start_ms, t_end_ms,
  req_headers_json, res_headers_json,
  req_body_ref NULL, res_body_ref NULL,               -- punteros a blobs
  resource_type, initiator_json, redirect_of NULL,
  classification,                                     -- core|static|third_party|analytics|noise
  included BOOLEAN)

browser_states(                                       -- punto de reanudación
  id, recording_id, name, storage_state_uri, created_at, expires_at)

fragments(id, name, description, current_version_id, ...)
fragment_versions(id, fragment_id, version_number, graph_json, interface_json, ...)

datasets(id, name, kind, current_version_id, ...)
dataset_versions(id, dataset_id, version_number, schema_json, data_uri, row_count, ...)

environments(id, name, vars_json, secrets_ref_json, ...)

runs(
  id, scenario_version_id, environment_id, dataset_version_id NULL,
  load_config_json, state, container_id,
  started_at, ended_at, summary_json, result_uri, triggered_by)

tags(id, name) ; taggings(tag_id, entity_type, entity_id)
folders(id, parent_id, name)
audit_log(id, actor, action, entity_type, entity_id, at, detail_json)
```

**Almacenamiento de artefactos** (no metas blobs grandes en la BD):

- **Captura cruda** en NDJSON comprimido (`raw_capture_uri`), un registro por evento/petición con orden y tiempos exactos; es la fuente reprocesable.
- **Cuerpos de petición/respuesta** deduplicados por hash de contenido en un almacén de blobs (volumen local o compatible S3; **[D5]**), con tope por cuerpo (p. ej. 1 MB, configurable) y marca de truncado.
- **`browser_states`** cifrados en reposo (contienen cookies/tokens).
- **Exportaciones:** HAR 1.2 generado bajo demanda a partir de la captura cruda.
- **Retención configurable:** política por proyecto (días) para capturas crudas y cuerpos; los escenarios y versiones **no** caducan. Borrado en cascada controlado y registrado en `audit_log`.
- **No se persisten frames de vídeo.** El streaming es efímero.

---

## 6. Pipeline de transformación: Recording → ScenarioVersion

Debe ser una **función pura y determinista** (misma captura + mismas reglas + misma `pipeline_version` ⇒ mismo resultado), ejecutada como trabajo asíncrono, idempotente y reintentable.

Etapas:

1. **Normalización.** Parsea la captura cruda, ordena por tiempo, resuelve cadenas de redirección, decodifica cuerpos (gzip/br), tipifica contenido.
2. **Clasificación y filtrado.** Etiqueta cada petición: `core` (API y documentos del dominio objetivo), `static` (js/css/img/fuentes), `third_party`, `analytics/ads`, `noise` (telemetría, favicon, preflights CORS redundantes). Reglas por lista (dominios, patrones, tipos de recurso) configurables por proyecto. Por defecto se incluyen solo `core`; el usuario decide en la revisión. **Todo lo excluido sigue en la captura cruda**; nada se pierde.
3. **Agrupación por pasos.** Usa los `Step` (manuales o automáticos) y los UIEvents para asignar peticiones; detecta peticiones paralelas (ráfagas) y mantenlas como grupo concurrente (`http.batch` en K6).
4. **Correlación (valores dinámicos).** Detecta valores que aparecen en una respuesta y se reusan en peticiones posteriores (tokens CSRF, IDs de sesión, IDs de recurso, nonces, JWT). Estrategia: índice de valores salientes por petición, búsqueda de coincidencias exactas y codificadas (URL, base64, JSON) en peticiones siguientes, con umbrales de entropía/longitud para evitar falsos positivos. Genera **reglas de extracción** (JSONPath, regex con grupo, cabecera, cookie) y **sustituciones** (`${variable}`), mostrando al usuario cada correlación propuesta con su confianza.
5. **Parametrización.** Detecta credenciales y datos de usuario (campos de login, emails, teléfonos, IDs) y propone sustituirlos por columnas del **Dataset** (Pool de usuarios con `SharedArray`). Base URL y hosts se convierten en variables de **Environment**. Los secretos nunca se incrustan en claro en el grafo ni en el script.
6. **Think time.** Deriva pausas realistas a partir de los intervalos entre UIEvents (acotadas por mín/máx y con opción de aleatorizar), como nodo de espera editable.
7. **Emisión del grafo (IR).** Produce el JSON del grafo con nodos de los tipos ya definidos (Autenticación, Petición HTTP, Validación de respuesta, Pool de usuarios) más nodos nuevos: **Extractor/Variable**, **Espera (think time)**, **Grupo concurrente**, **Fragmento**. Los pasos del usuario se mantienen como **contenedores/agrupaciones** visibles en el editor.
8. **Validación.** Verifica coherencia del grafo (variables definidas antes de usarse, dependencias sin ciclos, datasets enlazados), y genera el script K6 con el traductor existente (grafo → K6).
9. **Reporte del pipeline.** Resumen de qué se incluyó/excluyó, qué se correlacionó, qué se parametrizó, qué quedó fuera de alcance y advertencias; se guarda en `rules_snapshot_json` y se muestra en la pantalla de revisión.

**Requisitos de calidad:**

- Pruebas _golden-file_: capturas de ejemplo en `fixtures/` con grafo esperado.
- La versión del pipeline (`pipeline_version`) se guarda en cada ScenarioVersion; los cambios de reglas incrementan versión y no alteran versiones previas.
- **Reprocesar** una Recording con reglas distintas produce una **nueva** ScenarioVersion, nunca modifica una existente.

---

## 7. Reutilización: qué significa y cómo se materializa

La biblioteca debe soportar estas operaciones como funciones de primera clase (UI + API + tests):

1. **Reejecutar** una ScenarioVersion con otra carga, otro Environment u otro Dataset. El Run referencia la versión exacta (reproducibilidad); se muestra el hash del script ejecutado.
2. **Retomar una grabación.** Al finalizar (o en puntos marcados), puede guardarse un **BrowserState** (cookies, localStorage, sessionStorage vía `storageState` de Playwright). Una nueva grabación puede iniciarse **desde ese estado** (p. ej. ya autenticado) y **anexarse** a un escenario existente como pasos adicionales, generando una nueva versión del escenario.
3. **Anexar/combinar grabaciones.** Un escenario puede derivarse de varias grabaciones (cada versión registra sus procedencias).
4. **Reprocesar** una grabación con reglas nuevas sin volver a grabar (sección 6).
5. **Duplicar / bifurcar** un escenario (nuevo `Scenario` con la versión actual como base y enlace de linaje `forked_from`).
6. **Extraer Fragmento**: seleccionar un tramo del grafo (p. ej. login) y convertirlo en `Fragment` con interfaz (entradas, salidas, variables que exporta). Insertable en otros escenarios; las versiones de escenario **fijan** la versión del fragmento usada, con opción explícita de actualizar.
7. **Plantillas:** marcar un escenario como plantilla para crear nuevos a partir de él.
8. **Comparar versiones** de un escenario (diff de grafo y de script) y **comparar ejecuciones** (métricas lado a lado), ya contemplado en el historial.
9. **Importar/Exportar:** HAR (entrada para crear un Recording sintético y pasarlo por el pipeline), JSON de escenario K6Flow, script `.js` de K6 (descarga), y exportación de la grabación cruda.
10. **Archivar / restaurar** sin perder historial; el borrado definitivo requiere confirmación y respeta dependencias (no permitir borrar una versión referenciada por un Run sin política explícita).

---

## 8. Biblioteca: listados, búsqueda e identificación

### 8.1 Vistas (UI)

- **Biblioteca de escenarios:** tabla/tarjetas con nombre, descripción corta, etiquetas, carpeta, favorito, estado, versión actual, **origen** (grabación/manual/importado), autor, fecha de modificación, **última ejecución** (estado, fecha, p95, tasa de error), conteo de ejecuciones. Orden, filtros combinables (estado, etiqueta, carpeta, autor, origen, rango de fechas, resultado de última ejecución, con/sin grabación), búsqueda de texto (nombre, descripción, URLs, hosts, nombres de pasos, etiquetas).
- **Biblioteca de grabaciones:** lista con nombre, estado, URL inicial, duración, nº de pasos, nº de peticiones capturadas/incluidas, escenario(s) derivados, fecha. Acciones: abrir revisión, reprocesar, crear escenario, anexar, exportar HAR, eliminar.
- **Biblioteca de fragmentos y datasets:** con "usado en N escenarios" y versiones.
- **Detalle de escenario** con pestañas: **Resumen** · **Grafo** · **Script generado** (solo lectura, con hash) · **Grabaciones de origen** · **Versiones** (diff) · **Ejecuciones** · **Ajustes** (etiquetas, carpeta, permisos, archivo).
- **Detalle de grabación** con línea de tiempo de pasos/eventos, tabla de tráfico (incluido/excluido, con filtros), vista de correlaciones y parametrizaciones, y reproducción asistida de la secuencia de UIEvents (solo lectura, sin frames; muestra acciones y capturas de pantalla opcionales por paso si **D6** lo aprueba).

### 8.2 API REST (contrato mínimo; versionada bajo `/api/v1`)

```
GET    /scenarios?query=&tag=&folder=&status=&origin=&sort=&cursor=&limit=
POST   /scenarios
GET    /scenarios/{id}
PATCH  /scenarios/{id}                 # nombre, descripción, etiquetas, carpeta, favorito
POST   /scenarios/{id}/versions        # nueva versión (desde grafo editado)
GET    /scenarios/{id}/versions
GET    /scenarios/{id}/versions/{n}
GET    /scenarios/{id}/versions/{a}/diff/{b}
POST   /scenarios/{id}/fork
POST   /scenarios/{id}/archive         # y /restore
POST   /scenarios/{id}/runs            # lanza ejecución (versión, environment, dataset, carga)
GET    /scenarios/{id}/runs

POST   /recordings                     # crea y aprovisiona (devuelve recordingId + wsUrl + token)
GET    /recordings?state=&query=&cursor=
GET    /recordings/{id}
POST   /recordings/{id}/stop
POST   /recordings/{id}/reprocess      # body: reglas/overrides → nueva ScenarioVersion
POST   /recordings/{id}/save           # confirma revisión → crea/actualiza Scenario
GET    /recordings/{id}/steps
PATCH  /recordings/{id}/steps/{stepId} # renombrar/fusionar/dividir pasos (en la derivación)
GET    /recordings/{id}/requests?step=&class=&included=&cursor=
PATCH  /recordings/{id}/requests/{rid} # incluir/excluir en la derivación
GET    /recordings/{id}/export/har
POST   /recordings/{id}/browser-states # guarda punto de reanudación
POST   /recordings/{id}/uploads        # archivos para file chooser

GET/POST/PATCH /fragments ...  /datasets ...  /environments ...  /tags ...  /folders ...
POST   /import/har | /import/scenario
```

Requisitos: paginación por **cursor** (no offset), filtros por query string validados, errores con formato uniforme (`code`, `message`, `details`), idempotencia en `POST` críticos mediante cabecera `Idempotency-Key`, y autorización por proyecto en cada endpoint.

### 8.3 Identificación y nomenclatura

- Cada entidad tiene **ID estable** (ULID/UUID v7) y un **slug legible** único por proyecto.
- Nombres sugeridos automáticamente al guardar (p. ej. `{host}-{primer paso}-{fecha}`), siempre editables.
- Etiquetas libres + carpetas jerárquicas. Marcado de favoritos.
- Historial de cambios (`audit_log`) visible en el detalle.

---

## 9. Contratos entre servicios (resumen de responsabilidades)

| Servicio              | Responsabilidad en este complemento                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **web (Next.js)**     | UI del mini navegador, canvas, mapeo de coordenadas, biblioteca, revisión de grabación, editor de grafo, validación de mensajes con esquemas compartidos.                                                                             |
| **orchestrator (Go)** | Aprovisiona/destruye contenedores `recorder` y `k6`, aplica límites y red restringida, emite tokens efímeros del WS, mantiene el estado de `RecordingSession`, dispara el pipeline, expone la API REST de biblioteca, persiste en BD. |
| **recorder (Node)**   | Chromium headless + CDP, screencast, inyección de entrada, captura de red y UI, marcadores, `storageState`, escritura de captura cruda, apagado por inactividad/duración/desconexión.                                                 |
| **shared**            | Tipos y esquemas de mensajes WS/REST, IR del grafo, enumeraciones de estados.                                                                                                                                                         |

El **pipeline de transformación** puede vivir en `packages/shared` (TypeScript, reutilizable por `web` y `recorder`) o en el orquestador; **[D4]**.

---

## 10. Seguridad y privacidad específicas de la grabación

El recorder abre sitios arbitrarios dentro de nuestra infraestructura: trátalo como **código no confiable**.

- **Aislamiento de red del contenedor `recorder`:** red Docker dedicada; **bloquear** acceso a rangos privados/loopback/link-local y a metadatos del proveedor (`169.254.169.254`), al socket de Docker y a servicios internos (BD, orquestador). Solo salida a Internet hacia destinos permitidos. Resolución DNS controlada (defensa contra rebinding: validar la IP resuelta, no solo el hostname).
- **Allowlist de destinos** por proyecto (reutiliza la política de la herramienta de carga) y confirmación explícita del destino antes de iniciar (ya existe la pantalla de confirmación).
- **Contenedor endurecido:** usuario sin privilegios, `--cap-drop=ALL`, sistema de archivos de solo lectura salvo `tmpfs`, perfil seccomp por defecto, límites de CPU/memoria/PIDs/tiempo, sin montar nada sensible. Chromium con _sandbox_ activo cuando sea viable en el entorno (documentar el compromiso si se requiere `--no-sandbox`).
- **Tokens del WebSocket:** efímeros, firmados, de un solo uso para conectar, ligados a `recordingId` y usuario, con expiración corta; verificación de `Origin`. Rol controlador vs espectador.
- **Redacción de datos sensibles al persistir:** por defecto enmascara en la captura persistida `Authorization`, `Cookie`, `Set-Cookie`, campos `password/pass/pwd/token/secret`, y valores tecleados en `input[type=password]`; la **redacción es configurable** y debe respetar que para parametrizar se necesita el valor _conceptual_ (el pipeline trabaja con marcadores de variable, no con el secreto). Documenta con claridad qué se guarda en claro y qué no.
- **Cifrado en reposo** de `browser_states` y de cuerpos de captura cuando el almacenamiento lo permita; las credenciales de Environment se guardan por referencia a un almacén de secretos, nunca dentro del grafo ni del script.
- **Sin frames persistidos** y sin grabación de audio/vídeo. Aviso visible al usuario de qué se captura.
- **Límites de abuso:** grabaciones concurrentes por usuario/proyecto, duración máxima, tamaño máximo de captura, _rate limit_ en endpoints de aprovisionamiento.
- **Auditoría:** quién grabó, hacia qué destino, cuándo y con qué resultado.

---

## 11. Observabilidad y operación

- Métricas del recorder por sesión: fps efectivo, calidad, RTT, frames descartados, peticiones capturadas, tamaño de captura, uso de CPU/memoria. Exponlas para el panel de estado y logs estructurados con `recordingId`.
- Estados y transiciones registrados; trazas de errores de CDP con contexto.
- **Recolector de huérfanos** en el orquestador: reconcilia periódicamente contenedores `recorder` sin sesión activa y los elimina (garantía de que nunca queden recursos gastando el VPS).
- Pruebas de resistencia básicas: N grabaciones concurrentes y su impacto en CPU/RAM del VPS; documenta el límite recomendado.

---

## 12. Plan de implementación por fases (con criterios de aceptación)

**R1 — Streaming mínimo.** Recorder lanza Chromium, `startScreencast`, WS con frames binarios y `ack` con backpressure; UI muestra el canvas.
_Aceptación:_ se ve una página real en la UI a ≥5 fps; al cerrar la pestaña se destruye el contenedor.

**R2 — Control remoto.** Entrada de mouse/teclado/scroll/texto con mapeo de coordenadas; barra de navegación; pestañas y popups; diálogos JS; file chooser.
_Aceptación:_ se completa un flujo de login + formulario con subida de archivo sobre `fixtures/test-site` solo con la UI embebida.

**R3 — Captura y marcadores.** Captura de red vía CDP, UIEvents con selectores, pasos manuales/automáticos, pausa/reanudación, apagado por inactividad/desconexión, escritura de captura cruda.
_Aceptación:_ una grabación produce captura cruda completa y reabrible; los pasos agrupan correctamente el tráfico esperado.

**R4 — Pipeline.** Normalización, filtrado, agrupación, correlación, parametrización, think time, emisión del grafo + script K6 + pruebas golden.
_Aceptación:_ la grabación de `fixtures/test-site` genera un escenario que se ejecuta en K6 y pasa sus validaciones sin edición manual.

**R5 — Revisión y guardado.** Pantalla de revisión (pasos, tráfico incluido/excluido, correlaciones, parametrización), `save` con creación de Scenario/ScenarioVersion y procedencia.
_Aceptación:_ el usuario ajusta la derivación y guarda; el cambio se refleja en una nueva versión sin tocar la captura cruda.

**R6 — Biblioteca.** Listados, búsqueda, filtros, etiquetas, carpetas, favoritos, detalle con pestañas, versiones y diff, forks, archivado, API completa.
_Aceptación:_ encontrar un escenario por nombre, URL o paso, ver su procedencia y su última ejecución, y reejecutarlo desde la lista.

**R7 — Reutilización avanzada.** BrowserStates y retomar, anexar grabaciones, Fragmentos, Datasets y Environments versionados, importar HAR, exportar.
_Aceptación:_ retomar una grabación desde un estado autenticado y anexarla a un escenario existente generando la versión N+1.

**R8 — Endurecimiento.** Aislamiento de red, redacción, cifrado, límites, recolector de huérfanos, pruebas de concurrencia, documentación operativa.
_Aceptación:_ pruebas de intento de SSRF/acceso a red interna fallan como se espera; no quedan contenedores huérfanos tras fallos simulados.

**Pruebas transversales:** unitarias (mapeo de coordenadas, máquina de estados, clasificación, correlación), de integración con Chromium real, _golden files_ del pipeline y e2e del flujo completo grabar → revisar → guardar → ejecutar.

---

## 13. Entregables esperados en el repositorio

- `docs/recording.md`: arquitectura de grabación y streaming, con diagrama de secuencia.
- `docs/protocol-ws.md`: especificación del protocolo WS (formato binario y mensajes JSON).
- `docs/pipeline.md`: etapas, reglas, `pipeline_version` y cómo extenderlas.
- `docs/data-model.md`: esquema y política de retención.
- `docs/security-recorder.md`: modelo de amenazas y mitigaciones.
- `fixtures/test-site/` y `fixtures/captures/` con sus _golden files_.
- Migraciones de BD versionadas y OpenAPI de la API de biblioteca.

---

## 14. Decisiones abiertas — pregúntame antes de implementarlas

- **D1.** Base de datos: PostgreSQL vs SQLite (impacta búsqueda de texto, JSON y concurrencia). Dame recomendación.
- **D2.** Playwright vs Puppeteer para el recorder (este documento asume Chromium + CDP; ambos lo permiten, indícame cuál recomiendas y por qué).
- **D3.** WebSocket del recorder: conexión directa del navegador del usuario o proxificada por `web`/orquestador (impacta autenticación, TLS y despliegue en Docker Compose).
- **D4.** Dónde vive el pipeline de transformación: `packages/shared` (TS) o dentro del orquestador (Go).
- **D5.** Almacén de blobs: volumen local o S3 compatible (p. ej. MinIO) desde el inicio.
- **D6.** Capturas de pantalla por paso en la grabación (solo miniaturas opcionales almacenadas) frente a no persistir ninguna imagen.
- **D7.** Si el usuario necesita reproducir la sesión grabada **en navegador real** (no solo carga K6) como verificación funcional previa a la carga; de ser así, planificar un modo "replay" basado en selectores.

---

## 15. Reglas de trabajo para ti (el agente)

1. Antes de escribir código, resume en pocas líneas lo que entendiste de este complemento y lista las decisiones abiertas con tu recomendación.
2. Trabaja por fases R1→R8; al terminar cada una, ejecuta las pruebas y reporta qué cumple y qué no de los criterios de aceptación.
3. No amplíes el alcance sin consultarme; las funciones fuera de alcance v1 (sección 4.5) se diseñan como extensibles, no se implementan.
4. Ante una ambigüedad técnica con impacto en seguridad o en el modelo de datos, **pregunta**; en lo demás, decide, documenta la decisión en `docs/` y continúa.
5. Mantén los contratos (WS, REST, IR del grafo) definidos una sola vez en `packages/shared` y generados/validados en ambos extremos.
