# K6Flow — Prompt complementario: Editor visual de flujos (escenarios, nodos y pruebas en el editor)

> **Cómo usar este documento.** Complementa el prompt de inicialización original y el complemento de grabación/biblioteca de K6Flow. Para todo lo relacionado con el **editor de nodos (React Flow)**, **este documento prevalece** sobre lo descrito en el original. Conserva las decisiones ya tomadas (Next.js, orquestador en Go, REST para control, WebSocket para eventos en vivo, K6 en contenedores). Los puntos marcados **[DECISIÓN ABIERTA]** (sección 16) se preguntan antes de implementarse.

---

## 0. Diagnóstico del estado actual y objetivo

**Síntomas del editor actual (a corregir):**

1. Los nodos se dibujan, pero **al hacer clic no ocurre nada útil**: no hay panel de propiedades ni forma real de configurarlos.
2. No se puede **probar** un nodo ni el flujo desde el editor; no hay retroalimentación sobre si lo armado funciona.
3. Pocas opciones por nodo y pocos tipos de nodo; no alcanza para armar pruebas reales.
4. Sin validación, sin variables con ayuda contextual, sin vista del script generado, sin deshacer/rehacer, sin atajos: no se siente como una herramienta profesional.

**Objetivo:** un editor tipo n8n/Postman/Grafana k6 Studio combinados, en el que **cada elemento visible sea funcional**: seleccionar un nodo abre su configuración completa, se puede ejecutar ese nodo o el flujo con datos reales de prueba, se ven la petición, la respuesta, los checks y las variables extraídas, y el resultado alimenta una configuración de carga que se lanza con K6.

**Regla de oro de este trabajo (definición de "hecho"):** ningún botón, menú, handle o pestaña se muestra si no tiene comportamiento real implementado y probado. Lo que aún no exista se oculta o se marca explícitamente como "próximamente", nunca como control inerte.

---

## 1. Principios de diseño

1. **El grafo es datos, el editor es una vista.** La fuente de verdad es un documento JSON versionado y validado con esquema (el **IR del grafo**, sección 3). React Flow solo lo renderiza y edita. Nada de lógica de negocio dentro de componentes visuales.
2. **Nodos definidos por registro (plugin).** Cada tipo de nodo se declara en un registro único con su esquema de configuración, puertos, validación, traducción a K6, ejecución de prueba y componentes visuales. Añadir un nodo nuevo no debe tocar el núcleo del editor.
3. **Schema-driven UI.** Los formularios del inspector se generan a partir del esquema de configuración del nodo, con renderizadores de campo reutilizables (URL, clave-valor, JSON, selector de variable, etc.).
4. **Trazabilidad extremo a extremo.** Nodo ⇄ línea(s) de script K6 ⇄ petición de prueba ⇄ métrica de ejecución. Un mismo `nodeId` identifica cada nodo en todas las capas.
5. **Probar es de primera clase.** Antes de lanzar carga, el usuario debe poder verificar el flujo con 1 usuario y ver todo el detalle, nodo por nodo.
6. **Determinismo y reproducibilidad.** El mismo grafo + mismo entorno + mismo dataset debe producir el mismo script (hash estable).

---

## 2. Anatomía del editor (layout)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Barra superior: nombre · estado de guardado · versión · Deshacer/Rehacer │
│ · Validar · ▶ Probar flujo · Ver script · Configurar carga · ▶ Ejecutar  │
├───────────┬──────────────────────────────────────────┬───────────────────┤
│ Paleta /  │                                          │ Inspector del     │
│ Biblioteca│              Canvas (React Flow)         │ nodo seleccionado │
│ de nodos  │      minimapa · controles · cuadrícula   │ (pestañas)        │
│ + Fragm.  │                                          │                   │
├───────────┴──────────────────────────────────────────┴───────────────────┤
│ Panel inferior (colapsable): Resultado de prueba · Consola · Variables   │
│ · Problemas · Script generado · Línea de tiempo                          │
└──────────────────────────────────────────────────────────────────────────┘
```

- Paneles **redimensionables, colapsables y recordados** por usuario.
- **Paleta izquierda:** buscador, categorías, nodos arrastrables, sección "Fragmentos" (reutilizables) y "Recientes".
- **Inspector derecho:** contextual al elemento seleccionado (nodo, conexión, grupo o ninguno ⇒ propiedades del escenario).
- **Panel inferior:** resultados y depuración (sección 7).
- Tema oscuro por defecto con tema claro opcional; interfaz en español (Colombia) con i18n preparada.

---

## 3. Modelo del grafo (IR) y registro de nodos

### 3.1 Esquema del grafo

Define en `packages/shared` (TypeScript + validación en runtime, p. ej. zod) y úsalo en frontend, orquestador (generado a tipos Go desde JSON Schema) y traductores.

```jsonc
{
  "schemaVersion": 3,
  "id": "scn_01J...",
  "meta": {
    "name": "Checkout web",
    "description": "...",
    "tags": ["checkout"],
  },
  "settings": {
    "environmentRef": "env_...",
    "datasetRefs": ["ds_..."],
    "load": {/* ver sección 10 */},
  },
  "nodes": [
    {
      "id": "n_login",
      "type": "http.request",
      "typeVersion": 2,
      "name": "POST /login",
      "position": { "x": 320, "y": 120 },
      "disabled": false,
      "config": {/* validado contra configSchema del tipo */},
      "ui": { "color": "violet", "collapsed": false, "note": "" },
    },
  ],
  "edges": [
    {
      "id": "e1",
      "source": "n_start",
      "sourceHandle": "out",
      "target": "n_login",
      "targetHandle": "in",
      "label": "",
    },
  ],
  "groups": [
    {
      "id": "g1",
      "name": "Paso 1: Login",
      "nodeIds": ["n_login"],
      "stepRef": "step_1",
    },
  ],
  "variables": [{ "name": "token", "scope": "vu", "producedBy": "n_login" }],
}
```

Requisitos:

- **Migraciones de esquema** (`schemaVersion` y `typeVersion` por nodo) con funciones de migración probadas, para que escenarios viejos abran siempre.
- Posiciones y datos visuales (`ui`, `position`) **separados** de la semántica (`config`) para que el hash del script no cambie al mover un nodo.
- IDs estables (ULID); el nombre del nodo es editable y no es identificador.

### 3.2 Definición de un tipo de nodo (registro)

Cada nodo vive en `packages/nodes/<tipo>/` con esta interfaz (nombres orientativos, mantén la separación):

```ts
interface NodeDefinition<Config> {
  type: string; // "http.request"
  version: number;
  category: "flow" | "http" | "auth" | "data" | "logic" | "assert" | "util";
  title: string;
  description: string;
  icon: string;
  inputs: PortDef[]; // puertos de entrada tipados
  outputs: PortDef[]; // puertos de salida (p. ej. "ok", "error", "true", "false")
  configSchema: ZodSchema<Config>; // fuente del formulario y de la validación
  defaults(): Config;
  validate(config, ctx): Issue[]; // ctx: grafo, variables en scope, dataset, entorno
  toK6(node, ctx): K6Fragment; // código + metadatos de source map
  execute(node, runCtx): AsyncIterable<NodeEvent>; // ejecución de prueba (sección 7)
  Canvas: React.FC<NodeProps>; // vista compacta en el lienzo
  Inspector: React.FC<InspectorProps>; // pestañas del inspector
  docs: string; // ayuda embebida (markdown)
}
```

- **Puertos tipados:** `flow` (control de ejecución), `data` (valores). Solo se permiten conexiones válidas (se resalta qué handles aceptan la conexión mientras se arrastra).
- El **flujo de control** se modela con puertos `flow`; los valores entre nodos viajan por **variables** (sección 6), no por cables de datos, para mantener la traducción a K6 simple y explicable.

---

## 4. Catálogo de nodos (v1 ampliada)

Cada nodo debe ser **totalmente configurable desde el inspector**, tener estados visuales y poder probarse (salvo los puramente estructurales).

### 4.1 Estructura y control de flujo

| Nodo                        | Propósito                                                | Configuración clave                                                                                    |
| --------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Inicio**                  | Punto de entrada único del escenario.                    | Hooks `setup`/`teardown` opcionales; variables globales iniciales.                                     |
| **Fin / Detener**           | Termina la iteración o aborta la prueba.                 | Modo (`iteración`/`abortar`), motivo, código.                                                          |
| **Grupo (`group`)**         | Agrupa pasos y agrega etiqueta de métricas por grupo K6. | Nombre del grupo, tags.                                                                                |
| **Condicional (If/Else)**   | Bifurca según expresión.                                 | Condición (expresión o constructor visual de reglas); puertos `true`/`false`.                          |
| **Bucle**                   | Repite pasos.                                            | Modo: N veces / mientras (condición) / por cada elemento de lista; límite de seguridad de iteraciones. |
| **Paralelo (`http.batch`)** | Ejecuta peticiones concurrentes.                         | Ramas, límite de concurrencia, política de fallo.                                                      |
| **Espera (think time)**     | Pausa entre acciones.                                    | Fija / aleatoria (mín–máx) / distribución; unidad.                                                     |
| **Fragmento**               | Inserta un subflujo reutilizable.                        | Fragmento y versión fijada; mapeo de parámetros de entrada/salida.                                     |
| **Nota**                    | Documentación en el lienzo (no se ejecuta).              | Markdown, color.                                                                                       |

### 4.2 Peticiones y autenticación

| Nodo              | Propósito                        | Configuración clave                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Petición HTTP** | Núcleo del escenario.            | Método; URL con variables; **query params** (tabla activable por fila); **headers** (tabla, con presets); **cuerpo**: ninguno / JSON (editor con validación y resaltado) / `x-www-form-urlencoded` / `multipart` (campos y archivos) / texto crudo / **GraphQL** (query + variables); autenticación heredada o propia; timeout; redirecciones (seguir/máximo); compresión; jar de cookies (compartido/aislado); **tags** de métricas; **reintentos** (n, backoff, condiciones); nombre de la petición para agregación de métricas (`name` tag) y evitar cardinalidad alta por URLs dinámicas. |
| **Autenticación** | Obtener y mantener credenciales. | Tipos: **Bearer/JWT** (login → extraer token → inyectar), **Cookie/sesión** (login por formulario con jar), **Basic**, **API Key** (cabecera/query), **OAuth2 client credentials** (token endpoint, scopes, caché hasta expirar con renovación), **Personalizado**. Ámbito: por VU o compartido (con caché). Cómo inyectar en las siguientes peticiones (cabecera `Authorization`, cookie, etc.).                                                                                                                                                                                             |

### 4.3 Datos y variables

| Nodo                           | Propósito                                            | Configuración clave                                                                                                                                                                                                                             |
| ------------------------------ | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pool de usuarios / Dataset** | Datos parametrizados desde CSV/JSON (`SharedArray`). | Dataset y versión; **modo de selección**: secuencial por iteración, aleatorio, único por VU, único global sin repetir (con política al agotarse: reciclar/abortar/esperar); columnas expuestas como variables; vista previa de filas.           |
| **Extractor**                  | Extraer valores de una respuesta a variable.         | Origen (cuerpo/cabecera/cookie/estado/tiempo); método: **JSONPath**, **regex con grupo**, **selector CSS** (HTML), cabecera, cookie; índice/ocurrencia; valor por defecto; ¿obligatorio? (falla si no hay coincidencia); ámbito de la variable. |
| **Variable / Transformar**     | Definir o transformar valores.                       | Asignaciones `nombre = expresión`; funciones auxiliares (sección 6.3).                                                                                                                                                                          |
| **Generador de datos**         | Datos sintéticos por iteración.                      | Tipo: UUID, entero/decimal en rango, texto aleatorio, email, nombre, teléfono, fecha relativa, elección ponderada de lista; semilla opcional para reproducibilidad.                                                                             |

### 4.4 Validación y métricas

| Nodo                                  | Propósito                             | Configuración clave                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Validación de respuesta (`check`)** | Verifica la última respuesta.         | Lista de reglas combinables: estado (igual/rango/uno de), **cuerpo** contiene/regex/JSONPath con operadores (igual, existe, tipo, rango, longitud), **cabecera**, **tiempo de respuesta** (< X ms), **tamaño**, **esquema JSON** (validación contra JSON Schema). Nombre por regla, severidad (afecta métricas) y **acción ante fallo**: continuar / abortar iteración / abortar prueba. |
| **Métrica personalizada**             | Registrar valores propios.            | Tipo `Trend`/`Counter`/`Rate`/`Gauge`; nombre; valor (expresión); tags; ¿es tiempo?                                                                                                                                                                                                                                                                                                      |
| **Umbral (Threshold)**                | Criterios de aprobado/fallido global. | Métrica, agregación (`p(95)`, `avg`, `rate`, `count`…), operador, valor, ¿abortar al incumplir? (con retardo). (Puede vivir también en la configuración de carga, sección 10; en el lienzo se muestra como nodo de documentación enlazado.)                                                                                                                                              |

### 4.5 Utilidades

| Nodo                     | Propósito                         | Configuración clave                                                                                                                                                            |
| ------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Script personalizado** | Escape hatch en JavaScript de K6. | Editor Monaco con tipos de K6 y de las variables en scope, lint, límites; ejecuta en sandbox en pruebas del editor; entradas/salidas declaradas para el análisis de variables. |
| **Log / Depuración**     | Emitir mensajes.                  | Nivel y plantilla con variables (solo en modo prueba o también en carga, configurable).                                                                                        |

**Orden de entrega:** los nodos de 4.1–4.4 marcados con `●` en el plan (sección 14) primero; 4.5 al final. No expandas el catálogo sin consultarme.

---

## 5. Interacción y comportamiento del lienzo

### 5.1 Selección, edición y menús

- **Clic en nodo** ⇒ lo selecciona y **abre su Inspector** (nunca debe ser un gesto vacío). **Doble clic** ⇒ edición rápida del nombre y foco en el primer campo.
- **Inspector con pestañas por nodo:** **Configuración** · **Variables** (entradas que consume y salidas que produce) · **Validaciones** (si aplica) · **Probar** (ejecutar este nodo con datos de muestra y ver el resultado) · **Ayuda** (documentación embebida).
- **Menú contextual** (clic derecho): Ejecutar solo este nodo · Ejecutar hasta aquí · Duplicar · Desactivar/Activar · Copiar/Pegar · Agrupar · Convertir en fragmento · Ver en script · Eliminar. Menú contextual del lienzo vacío: Pegar, Añadir nodo aquí, Auto-organizar.
- **Estados visuales del nodo:** válido · advertencia · error de configuración · desactivado · en ejecución · éxito · fallo · omitido (rama no tomada). Con icono y color accesibles (no solo color).
- **Conexiones:** arrastrar desde handle, **soltar sobre espacio vacío abre el buscador de nodos** para crear y conectar; resaltar handles compatibles; rechazar conexiones inválidas con mensaje; etiquetas editables en conexiones; hacer clic en una conexión muestra su inspector (condición, etiqueta).
- **Selección múltiple** (marquesina, `Shift`/`Ctrl`), mover en bloque, alinear/distribuir, **ajuste a cuadrícula**, **auto-organización** (dagre/ELK, de izquierda a derecha) y reorganización manual preservada.
- **Grupos colapsables** con nombre y color (mapean a `group` de K6 o a pasos de una grabación).
- **Minimapa, zoom, ajustar a pantalla, ir a nodo seleccionado.**
- **Búsqueda global** (`Ctrl/Cmd+K`): nodos del escenario, tipos para añadir, comandos de la barra superior, fragmentos.

### 5.2 Deshacer/rehacer y atajos

- **Historial de comandos** (patrón Command o parches de Immer) con deshacer/rehacer ilimitados por sesión; cada acción compuesta (pegar, convertir en fragmento, auto-organizar) es **una sola entrada**.
- Atajos mínimos: `Ctrl/Cmd+Z` / `Shift+Z` deshacer/rehacer · `Ctrl/Cmd+C/V/X/D` copiar/pegar/cortar/duplicar · `Supr` eliminar · `Ctrl/Cmd+G` agrupar · `Ctrl/Cmd+Enter` probar flujo · `Ctrl/Cmd+Shift+Enter` probar hasta el nodo seleccionado · `Ctrl/Cmd+S` guardar versión · `Ctrl/Cmd+K` buscar · `F2` renombrar · flechas para mover selección · `Espacio+arrastre` desplazar lienzo. Panel de **ayuda de atajos** (`?`).
- **Copiar y pegar entre escenarios** (portapapeles con JSON del subgrafo, reasignando IDs y resolviendo variables huérfanas con advertencia).

### 5.3 Accesibilidad y rendimiento

- Navegación completa por teclado (foco visible, orden lógico, alternativa a arrastrar para conectar), roles ARIA en inspector, contraste suficiente.
- Rendimiento: `React.memo` en nodos, store con selectores granulares, `onlyRenderVisibleElements` para grafos grandes, evitar re-render global al mover un nodo. Objetivo: fluidez con **≥ 300 nodos**; medirlo con una prueba de rendimiento automatizada.

---

## 6. Variables, ámbitos y expresiones

### 6.1 Modelo

- **Ámbitos:** `env` (entorno, solo lectura), `data` (columnas del dataset de la fila actual), `vars` (variables del escenario, por VU), `global` (compartidas, solo lectura tras `setup`), `prev` (atajo a la última respuesta), `iter` (índice de iteración, id de VU).
- El análisis de variables es **estático sobre el grafo**: para cada nodo se calcula qué variables están **definidas y alcanzables** (recorrido topológico del flujo, considerando ramas y bucles). Esto alimenta autocompletado y validación.

### 6.2 Sintaxis de expresiones

- Plantillas con llaves dobles en cualquier campo de texto marcado como "admite variables": `{{vars.token}}`, `{{env.baseUrl}}`, `{{data.email}}`, `{{prev.json.id}}`, `{{prev.status}}`.
- **No uses `eval`.** Implementa un **tokenizador/parser propio** de un subconjunto de expresiones (acceso a propiedades, índices, literales, operadores aritméticos/lógicos/comparación, llamadas a funciones auxiliares permitidas) y **compílalo** a JavaScript K6 seguro; el mismo parser alimenta el intérprete de pruebas del editor.
- **Editor de campo con ayuda:** resaltado, **autocompletado contextual** (solo variables alcanzables en ese punto, con tipo inferido y de qué nodo vienen), botón "insertar variable", **vista previa del valor resuelto** (con datos de la última prueba o muestra) y errores en línea (variable inexistente, función desconocida, sintaxis).

### 6.3 Funciones auxiliares integradas

`$uuid()`, `$timestamp()`, `$isoDate(offset)`, `$randomInt(min,max)`, `$randomString(n)`, `$pick(lista)`, `$base64(x)`, `$urlencode(x)`, `$json(x)`, `$md5/$sha256(x)` (si K6 lo permite con módulos estándar), `$env(name)`. Documentadas en la ayuda y con prueba unitaria cada una.

### 6.4 Seguridad de valores

- Las variables marcadas como **secretas** (credenciales, tokens) se muestran enmascaradas en UI, logs y resultados de prueba, y **nunca** se escriben en claro en el script generado ni en el grafo: se referencian desde el Environment.

---

## 7. Probar en el editor (la pieza central)

### 7.1 Modos de prueba

1. **Probar nodo** (`Ejecutar solo este nodo`): ejecuta un nodo de forma aislada con **contexto simulado** (variables de muestra definidas por el usuario o tomadas de la última prueba).
2. **Probar hasta aquí:** ejecuta desde el Inicio hasta el nodo seleccionado (1 usuario, 1 iteración) y se detiene.
3. **Probar flujo completo:** 1 usuario virtual, 1 iteración, con dataset de muestra (fila elegida o la primera) y Environment elegido.
4. **Paso a paso (depurador):** puntos de interrupción en nodos, `Continuar` / `Siguiente nodo` / `Detener`, y **inspector de variables** en vivo en cada pausa. Se puede **editar el valor de una variable** y continuar.
5. **Smoke run con K6 real (1 VU, 1 iteración):** verificación final con el motor real antes de la carga (ver 7.4).

### 7.2 Qué muestra cada nodo ejecutado (panel inferior y pestaña "Probar")

- **Petición enviada:** método, URL **resuelta**, headers (con secretos enmascarados), cuerpo resuelto (formateado), cookies enviadas.
- **Respuesta:** estado, headers, cuerpo con vistas **Formateado / Crudo / Vista previa HTML**, tamaño, y **desglose de tiempos** (bloqueado, DNS, conexión, TLS, envío, espera/TTFB, recepción) con gráfico tipo _waterfall_.
- **Validaciones:** cada regla con ✓/✗, valor esperado vs. obtenido y resaltado del fragmento relevante.
- **Variables:** extraídas/modificadas por el nodo (antes → después).
- **Logs y errores:** mensajes del nodo, errores de red/timeout con causa legible y sugerencia.
- **Línea de tiempo del flujo completo:** lista/waterfall de todos los nodos ejecutados con duración y estado; clic ⇒ centra y selecciona el nodo en el lienzo.
- Los nodos del lienzo muestran su estado (éxito/fallo/omitido) y un resumen mínimo (código HTTP, ms) **sobre el propio nodo**.
- Botones: **Re-ejecutar**, **Copiar como cURL**, **Guardar respuesta como muestra** (para probar otros nodos sin volver a pedir), **Comparar con la ejecución anterior** (diff de respuesta).

### 7.3 Arquitectura de ejecución de pruebas

- **Endpoint (REST) del orquestador:** `POST /api/v1/test-runs` con `{ scenarioVersion | graph, mode: "node|until|flow|debug", targetNodeId?, environmentId, datasetRowRef?, sampleVars?, breakpoints? }` ⇒ `{ testRunId, wsUrl, token }`. Control del depurador por REST (`POST /test-runs/{id}/continue|step|stop`) o mensajes WS.
- **Eventos por WebSocket** (`/ws/test-runs/{id}`), `t` discriminante: `test.started`, `node.started`, `node.request`, `node.response`, `node.checks`, `node.vars`, `node.log`, `node.finished` (con estado), `debug.paused` (nodo + snapshot de variables), `test.finished` (resumen), `test.error`. Esquemas definidos una vez en `packages/shared`.
- **Dónde se ejecuta:** en un **contenedor efímero aislado** (misma política de red, allowlist y límites que el recorder y K6), nunca en el proceso del orquestador. Límites duros: tiempo máximo, tamaño máximo de cuerpo guardado, número máximo de peticiones por prueba.
- **Motor de prueba:** ver **D1** (intérprete propio frente a K6 real en modo traza). Cualquiera sea la elección, el resultado debe ser el **mismo formato de eventos** hacia la UI.

### 7.4 Paridad con K6 (obligatoria)

Para evitar el clásico "funciona en el editor pero falla en la carga":

- Si se elige un **intérprete propio**, escribe **pruebas de conformidad**: un conjunto de grafos de referencia que se ejecutan en el intérprete **y** en K6 real contra un servidor de pruebas local (`fixtures/test-server`), comparando secuencia de peticiones, valores extraídos y resultados de checks. Cualquier divergencia rompe el CI.
- Documenta las diferencias conocidas e inevitables (p. ej. métricas internas de K6) y muéstralas en la ayuda.
- Ofrece siempre el **Smoke run con K6 real** (1 VU/1 iteración) como paso final antes de "Ejecutar carga", y recomiéndalo en la UI si el escenario cambió desde el último smoke exitoso.

### 7.5 Seguridad de las pruebas del editor

- Aplican **exactamente** las reglas de SSRF y allowlist de destinos del resto de la herramienta, más confirmación del destino antes de la primera prueba de un escenario nuevo.
- Las pruebas del editor **nunca** generan carga (1 VU, tasa máxima limitada, sin bucles infinitos: límite de iteraciones y tiempo).
- Secretos enmascarados en eventos, logs y respuestas guardadas; redacción configurable de cuerpos.

---

## 8. Validación continua y panel de Problemas

- **Validación en vivo** (con _debounce_) del grafo y de cada nodo. Severidades: **Error** (bloquea ejecutar carga y probar si afecta el camino), **Advertencia** (permite continuar), **Información**.
- Reglas mínimas: exactamente un nodo Inicio; nodos huérfanos/inalcanzables; ciclos no permitidos sin nodo Bucle; puertos obligatorios sin conectar; **variables usadas sin definición alcanzable**; variable definida y nunca usada (info); URL/método inválidos; JSON de cuerpo malformado; `Content-Type` incoherente con el cuerpo; dataset o columna inexistente; fragmento con versión faltante; umbral sobre métrica inexistente; ramas del condicional sin cierre; tiempos de espera absurdos; secretos en claro en campos de texto.
- **Panel de Problemas:** lista agrupada por severidad y nodo; clic ⇒ selecciona el nodo y enfoca el campo con el error; **corrección rápida** cuando exista (p. ej. "Crear variable `token`", "Conectar a Inicio").
- Insignias de error/advertencia en el nodo y contador en la barra superior. El botón **Ejecutar carga** muestra el motivo si está deshabilitado.

---

## 9. Script generado y trazabilidad

- Panel **"Script K6"** (Monaco, solo lectura, resaltado JS) con el script de la versión actual, **hash**, botón copiar/descargar y opción "ver diferencias vs. versión anterior".
- **Source map nodo ⇄ código:** el traductor registra, por nodo, el rango de líneas que genera. Al seleccionar un nodo se **resalta su código**; al hacer clic en una línea se **selecciona el nodo** que la originó.
- Generación **determinista y legible**: código ordenado, comentarios con el nombre del nodo, sin datos visuales en el hash.
- El nodo **Script personalizado** inserta su código tal cual, con sus variables de entrada/salida declaradas para el análisis estático.
- Pruebas _golden_: para cada tipo de nodo y para escenarios compuestos, grafo de entrada ⇒ script esperado (snapshot), más ejecución real del script en K6 contra `fixtures/test-server`.

---

## 10. Configuración de carga integrada al editor

Pestaña/panel **"Carga"** del escenario (no un formulario aparte y opaco):

- **Presets:** _Smoke_, _Load_, _Stress_, _Spike_, _Soak_, _Breakpoint_, con valores iniciales explicados y editables.
- **Ejecutores de K6** soportados: `constant-vus`, `ramping-vus`, `constant-arrival-rate`, `ramping-arrival-rate`, `per-vu-iterations`, `shared-iterations`. Campos específicos por ejecutor, validación (p. ej. `preAllocatedVUs`/`maxVUs`) y explicación breve en la interfaz.
- **Editor visual de etapas (stages):** gráfico de línea tiempo × VUs/tasa **editable arrastrando puntos**, sincronizado con la tabla de etapas; vista previa del perfil, duración total estimada y pico de VUs.
- **Umbrales:** tabla (métrica, agregación, operador, valor, abortar al incumplir) con sugerencias (`http_req_duration p(95)<…`, `http_req_failed rate<…`).
- **Escenarios múltiples** (varios ejecutores en paralelo, `exec` por flujo) como extensión planificada; diseña el esquema para permitirlo aunque la UI v1 sea de un único perfil.
- **Parámetros globales:** tags, `userAgent`, `noConnectionReuse`, DNS, límites de recursos del contenedor, región/etiquetas de ejecución.
- **Estimación de recursos** (CPU/RAM aproximada del contenedor según VUs) con advertencia si excede el límite del VPS, **antes** de lanzar.
- Al pulsar **▶ Ejecutar carga:** validación → (smoke recomendado) → pantalla de confirmación de destino → ejecución en vivo (ya existente).

---

## 11. Persistencia, versiones y colaboración

- **Autoguardado** de borrador (local + servidor) con indicador de estado ("Guardado", "Guardando…", "Cambios sin guardar", "Conflicto").
- **Guardar versión** crea una `ScenarioVersion` inmutable con nota opcional; el borrador se distingue de las versiones guardadas.
- **Historial de versiones** con restaurar y **diff visual** de grafo (nodos añadidos/eliminados/modificados resaltados) y de script.
- **Concurrencia optimista:** cada guardado envía la versión base; si el servidor tiene cambios posteriores, se muestra el conflicto con opciones (recargar, guardar como copia). **Colaboración en tiempo real** (CRDT/Yjs) queda **fuera de v1**, pero el modelo de comandos y el IR no deben impedir añadirla después (**D4**).
- **Importar/Exportar:** JSON del escenario, script K6, y pegado de subgrafos. **Plantillas** de inicio (p. ej. "API REST con login JWT", "Flujo web con formulario", "CRUD básico").

---

## 12. Integración con el flujo de grabación

- Los nodos generados desde una grabación llegan **agrupados por Step** (`groups[].stepRef`), con un indicador de **procedencia**.
- En el Inspector de un nodo generado, pestaña **Origen:** petición/respuesta cruda capturada, valores detectados como dinámicos y por qué, y acciones **"Regenerar desde captura"**, **"Excluir"** y **"Convertir en fragmento"**.
- Desde el editor se puede **abrir la grabación de origen** y, al retomar o anexar una grabación, ver los nodos nuevos resaltados como "añadidos".

---

## 13. Arquitectura del frontend (guía técnica)

- **React Flow (`@xyflow/react`)** para el lienzo; nodos y aristas **personalizados** desde el registro.
- **Estado:** Zustand + Immer, con **tres almacenes separados**: (a) _documento_ (grafo; pasa por historial de comandos), (b) _UI_ (selección, paneles, zoom), (c) _ejecución_ (estado de pruebas y resultados). El lienzo no es dueño del estado del grafo.
- **Formularios del inspector** generados desde el esquema (React Hook Form + zod resolver) con renderizadores propios: clave-valor, JSON, selector de variable, selector de dataset/columna, editor de reglas, editor de stages, etc.
- **Monaco Editor** para JSON, cuerpos, script personalizado y panel de script.
- **TanStack Query** para datos del servidor (escenarios, versiones, datasets); cliente WS tipado para eventos de prueba.
- **UI:** el sistema de componentes ya elegido (p. ej. shadcn/ui + Tailwind), con tokens de diseño comunes con el resto de pantallas.
- **Estructura sugerida:**

  ```
  apps/web/src/features/editor/   (canvas, panels, store, commands, shortcuts)
  packages/nodes/<tipo>/          (schema, Canvas, Inspector, toK6, execute, docs)
  packages/flow-core/             (IR, migraciones, validación, análisis de variables, parser de expresiones, source maps)
  packages/shared/                (esquemas WS/REST compartidos)
  ```

- `packages/flow-core` debe ser **independiente de React** (TypeScript puro) para poder usarse en pruebas, en el traductor y, si se decide, en el intérprete de pruebas.

---

## 14. Plan de implementación por fases (con criterios de aceptación)

`●` = nodo/funcionalidad prioritaria.

**E1 — Cimientos.** IR + migraciones, registro de nodos, store separado, historial de comandos, layout de paneles, selección ⇒ Inspector funcional con 3 nodos: Inicio ●, Petición HTTP ●, Validación ●.
_Aceptación:_ se arma un flujo de 3 nodos, cada clic abre un inspector que **edita de verdad** el nodo; deshacer/rehacer funciona; recargar la página conserva el borrador.

**E2 — Variables y expresiones.** Ámbitos, análisis estático, parser/compilador de expresiones, campo con autocompletado y vista previa, nodos Extractor ● y Variable ●, secretos enmascarados.
_Aceptación:_ extraer un token de una respuesta y usarlo en la siguiente petición con autocompletado; una variable no definida produce un error claro.

**E3 — Probar en el editor (núcleo).** Endpoint `test-runs`, eventos WS, modos _nodo / hasta aquí / flujo_, panel de resultados (petición, respuesta, tiempos, checks, variables), estados sobre los nodos.
_Aceptación:_ probar un flujo login → consulta contra `fixtures/test-server` y ver todo el detalle por nodo; error de red mostrado con causa legible; límites y allowlist verificados con pruebas.

**E4 — Validación y Problemas.** Motor de reglas, panel de Problemas, correcciones rápidas, bloqueo de ejecución con motivo.
_Aceptación:_ cada regla de la sección 8 tiene prueba unitaria y un caso visible en UI.

**E5 — Script, source map y paridad.** Traductor con source map, panel de script, _golden files_, pruebas de **conformidad** intérprete vs. K6 (o integración del modo traza, según D1), smoke run real.
_Aceptación:_ seleccionar un nodo resalta su código y viceversa; suite de conformidad en verde en CI.

**E6 — Catálogo ampliado.** Autenticación (todos los tipos) ●, Dataset ●, Condicional, Bucle, Grupo, Paralelo, Espera, Generador de datos, Métrica personalizada, Nota, Fragmento, Script personalizado, Log.
_Aceptación:_ cada nodo configurable, validable, traducible y probable; documentación embebida completa.

**E7 — Depurador y carga integrada.** Puntos de interrupción, paso a paso, edición de variables; panel **Carga** (presets, ejecutores, editor visual de stages, umbrales, estimación de recursos).
_Aceptación:_ depurar un flujo con un breakpoint y modificar una variable; configurar una rampa arrastrando puntos y lanzar la carga desde el editor.

**E8 — Pulido profesional.** Búsqueda global, menús contextuales completos, auto-organización, copiar/pegar entre escenarios, historial de versiones con diff visual, plantillas, accesibilidad, rendimiento con ≥300 nodos, integración con grabación (sección 12).
_Aceptación:_ recorrido e2e completo y checklist de accesibilidad y rendimiento documentados.

**Pruebas transversales:** unitarias (`flow-core`, parser, validación, traductores), componentes (Inspector y campos), **e2e con Playwright sobre el editor** (arrastrar, conectar, configurar, probar, guardar, lanzar), golden files y conformidad con K6.

---

## 15. Entregables esperados en el repositorio

- `docs/editor.md` (arquitectura y guía de contribución de nodos), `docs/node-authoring.md` (cómo crear un nodo paso a paso con ejemplo), `docs/expressions.md`, `docs/test-runs.md` (protocolo WS y modos), `docs/ir-schema.md` con migraciones.
- `fixtures/test-server/` (servidor de pruebas con login, tokens, JSON, formularios, errores, latencias) y `fixtures/graphs/` con _golden files_.
- Catálogo de nodos con su documentación en `packages/nodes/*/docs.md`, mostrada en la pestaña **Ayuda** del inspector.

---

## 16. Decisiones abiertas — pregúntame antes de implementarlas

- **D1. Motor de las pruebas del editor.** (a) **Intérprete propio** en el orquestador (Go) que ejecuta los nodos con HTTP real: rápido, interactivo, permite probar un nodo suelto y depurar paso a paso, pero exige pruebas de conformidad para garantizar paridad con K6; (b) **K6 real en modo traza** (1 VU/1 iteración, salida detallada): máxima fidelidad, pero más lento, sin ejecución de nodo aislado ni depuración interactiva real. Mi inclinación es (a) + smoke run con (b), pero recomiéndame con tus argumentos.
- **D2. Biblioteca de formularios y UI del inspector:** renderizadores propios sobre React Hook Form + zod frente a un generador de formularios desde JSON Schema ya existente.
- **D3. Lenguaje del intérprete/parsers:** si el parser de expresiones vive en TypeScript (`flow-core`) y el intérprete en Go, cómo evitar duplicar la semántica (opciones: generar ambos desde una especificación común, o ejecutar el intérprete también en Node).
- **D4. Colaboración en tiempo real (Yjs/CRDT):** posponer a una fase posterior (propuesto) o incluirla desde el diseño del estado.
- **D5. Fragmentos:** alcance en v1 (solo insertar/versionar, o también parámetros tipados y salidas) y política de actualización de versiones fijadas.
- **D6. Soporte de GraphQL, multipart con archivos y OAuth2** en v1 o en una segunda iteración.
- **D7. Persistencia de respuestas de prueba** ("muestras"): ¿se guardan con el escenario (útil para probar sin volver a llamar) o solo en memoria de la sesión (más seguro por datos sensibles)?

---

## 17. Reglas de trabajo para ti (el agente)

1. Antes de escribir código, resume en pocas líneas qué entendiste del problema y lista las **decisiones abiertas con tu recomendación**.
2. Trabaja por fases E1→E8; al cerrar cada una, ejecuta las pruebas y reporta qué criterios de aceptación se cumplen y cuáles no, con evidencia (salida de tests, capturas, logs).
3. **No dejes controles inertes**: si algo no está implementado, no se muestra o se marca explícitamente como no disponible.
4. No amplíes el alcance sin consultarme; lo que quede fuera se documenta como extensión planificada.
5. Mantén el IR, los mensajes WS/REST y los esquemas de configuración **definidos una sola vez** en `packages/shared` / `packages/flow-core` y consumidos por todos los servicios.
6. Ante ambigüedades que afecten el modelo de datos, la seguridad o la paridad con K6, **pregunta**; en lo demás, decide, documenta en `docs/` y continúa.
