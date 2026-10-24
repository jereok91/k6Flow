# K6Flow — importación de HAR con filtros y tiempos

Importar un `.har` para construir un escenario, con filtros estilo DevTools y
tiempos reales entre peticiones. Entrada de referencia del usuario:
`docs/examploHar.har` (16 peticiones, HAR 1.2 exportado del navegador).

## Specs

S1 — Soportar archivos HAR como fuente de escenario.
> "necesito alguna manera de podedor soportar archivos comoe que te deje en @docs/examploHar.har paar que etengas un ejemplo simple de lo que tiene un archivo .har y que apartir de este se puededan contruir scenario al momento de imporatar"

S2 — Poder filtrar como las DevTools, para guardar solo las peticiones deseadas.
> "dbe se posible filtrar por pito de peticiones y demas flitros como los de las dev tools de los navegadores para solamente guaradar en el esenarios las peticiones deseadas"

S3 — Al importar, poder ajustar los tiempos entre peticiones.
> "ademas cuando este adicionado las query debe ser capaz de ajiatar tiempso entre cada peticion y ese tipo de cosas"

S4 — (opcional) detectar host, token o cookie como variables fáciles de actualizar.
> "tratatr de detectar para poder manejar tema de conocar una variable de entorno a host, o el token o el cooki o cosas de este estilo que perumitan inegrar de manera dinamica y facil de actualizar el futuro estas opciones de variables es opcional"

## Decisiones

- D1 — Los filtros viven en `HarImportOptions` (paquete compartido) para poder
  probarlos sin navegador; la ruta solo los transporta.
- D2 — El tipo se clasifica como en DevTools: `document | xhr | fetch | script |
  stylesheet | image | font | media | websocket | other`, tomando `_resourceType`
  cuando la entrada lo trae y si no el `mimeType` de la respuesta.
- D3 — Los tiempos salen del propio HAR: `startedDateTime + time` de cada entrada,
  y el hueco hasta la siguiente se escribe como `waitSeconds` en la conexión, que
  es el campo que el traductor ya convierte en `sleep()`. Se acota a 0..3600 y se
  puede desactivar con `useHarTimings`.
- D4 — Las variables (S4) se resuelven en una rebanada aparte (T7) y el importador
  **sugiere, no impone**: detecta candidatos con su motivo y solo aplica placeholders
  cuando el llamador lo pide explícitamente.
- D6 — El usuario dispuso que `docs/examploHar.har` **no se versiona** (export real con
  dominios internos): queda en `.gitignore` y los tests de aceptación se saltan cuando
  falta.
- D5 — (hallazgo del padre, bloquea el objetivo real de S1) `POST /api/import/har`
  guarda `result.graph` crudo en `scenarios.graph`, pero ese grafo es
  `HarImportedGraph` (`{nodes: Record, edges:[{from,to,waitSeconds}], startNode}`)
  mientras que el editor valida con `graphDraftCompositionSchema`
  (`{version, nodes:[{id,kind,references,parameters…}], connections:[{source,target,waitSeconds}]}`).
  Hoy un escenario importado de un HAR **no se puede abrir en el editor**. Hace falta
  una conversión explícita `HarImportedGraph → GraphDraftComposition`, con los
  parámetros planos (`method/url/headers/body/contentType`) traducidos a los esquemas
  por tipo de nodo, y `edges` → `connections` conservando `waitSeconds`.

## Tasks

- [x] T1 Filtros: tipo de recurso (incluir/excluir), método, rango de estado y
      dominio, en `HarImportOptions` y `importHar`.
- [x] T2 Tiempos: derivar `waitSeconds` por conexión desde el HAR.
- [x] T3 Ruta `/api/import/har`: transportar los filtros nuevos y documentarlos.
- [x] T4 Tests: clasificación por tipo, cada filtro por separado y combinados,
      tiempos (incluido el caso de entradas simultáneas y el tope), y el HAR real
      de `docs/examploHar.har` como caso de aceptación.
- [x] T5 Suites y cierre.
- [x] T6 Puente `HarImportedGraph → GraphDraftComposition` (D5): conversión con tests,
      usada por la ruta antes de guardar, para que el escenario importado abra en el editor.
- [x] T7 Variables sugeridas por caso (S4/D4): detectar host, `Authorization`, cookies,
      API keys y tokens en query; devolver sugerencias con motivo y secreto sí/no, sin
      aplicarlas salvo pedido explícito; aplicar placeholders `{{nombre}}` en la composición.

## Log

L1 (pedido original, verbatim, dos mensajes):
> necesito alguna manera de podedor soportar archivos comoe que te deje en @docs/examploHar.har paar que etengas un ejemplo simple de lo que tiene un archivo .har  y que  apartir  de este se puededan contruir scenario al momento de imporatar dbe se posible filtrar por pito de peticiones y demas flitros como los de las dev tools de los navegadores para solamente guaradar en el esenarios las peticiones deseadas. Tener en cuenta y tratatr de detectar para poder manejar tema de conocar una variable de entorno a host, o el token o el cooki o cosas de este estilo que perumitan inegrar de manera dinamica y facil de actualizar el futuro estas opciones de variables es opcional

> ademas cuando este adicionado las query debe ser capaz de ajiatar tiempso entre cada peticion y ese tipo de cosas

## Evidencia

| Rebanada | Commit | Líneas | Verificación |
| --- | --- | --- | --- |
| Filtros + tiempos | `bceb283` | 370 insertadas / 38 borradas + 579 de tests nuevos | 41 focales, `pnpm test` 1973, typecheck 0/0; sobre el HAR real: 16/16 importadas, 5 pasos, esperas 1.699/3.042/6.715/2.473 s |
| Puente a composición | (este commit) | 345 + 466 de tests | 29 focales, `pnpm test` 1994, typecheck 0/0, build 0; composición de 16 nodos / 15 conexiones / 4 esperas que **pasa `graphDraftCompositionSchema`** |

Aceptación sobre `docs/examploHar.har` (con `excludeStatic: false`): grafo importado
20 nodos (16 peticiones + 4 grupos), 5 pasos, 4 aristas; composición 16 nodos y 15
conexiones lineales, 4 de ellas con espera, `warnings: []`.

La aceptación se **salta** cuando el archivo de referencia no existe (no está
versionado): con el archivo 52 tests pasan; sin él pasan 50 y 2 se saltan, así CI no
falla por ENOENT.

## Pendiente de decisión del usuario

`docs/examploHar.har` sigue **sin trackear**: es un export real con dominios internos
(`np-consiglia.digitalgex.com`, `backend-consiglia-qa.digitalgex.com`) y sin
credenciales. Falta decidir si se commitea tal cual, saneado o se deja fuera.

## Limitaciones conocidas

- Solo los huecos **entre pasos** se convierten en espera: el grafo importado agrupa
  las peticiones de un paso y no tiene aristas internas, así que los tiempos dentro de
  un paso no son representables sin cambiar su forma.
- `httpParametersSchema` no tiene campo `contentType`: los tipos representables se
  conservan por el `kind` del body; el resto (multipart, binario) entra como `text`
  **con warning**. Un body sin content type se adivina json → form → text, con warning.
- Cuerpos base64 en HAR se importarían como texto sin señal (el export de referencia no
  tiene cuerpos).
- Para POST/PUT el importador conserva el header `Content-Type` y el traductor emite el
  suyo por el tipo de body, así que el objeto `headers` puede llevar dos claves
  `Content-Type` (gana la última). Comportamiento preexistente, no de esta feature.

## T7 — variables sugeridas (evidencia)

`har-variables.ts` (533 líneas) + 29 tests; ruta +20/−1 con 4 tests nuevos.

Aceptación sobre `docs/examploHar.har`: **2 sugerencias, ambas `host`**, no secretas,
`baseUrl1` y `baseUrl2` (ocurrencias 1 y 15), `reasonCode: repeated-origin`, **cero**
de authorization/cookie/api-key/query — el archivo no trae esas cabeceras y ninguno de
sus parámetros de query coincide con el patrón de credenciales.

Casos donde deliberadamente **no** sugiere (un variable sería una mentira):
authorization que nunca se repite (tokens por request); cookie o API key con valores
distintos entre requests; pares cookie vacíos; query cuyo nombre no parece credencial
o cuyo valor tiene menos de 8 caracteres; query con valor variable; URL no parseable.
Al aplicar, ignora sugerencias con nombre inválido o valor vacío, para no corromper una
composición armada a mano.

Verificación del padre: 43 tests focales, `pnpm test` **2027**, typecheck 0/0, build 0.

## T8 — pantalla de importación

Sin UI la ruta no se usa: falta subir el `.har`, ver las peticiones con filtros de
DevTools, elegir cuáles van, revisar las variables sugeridas y confirmar.

Decisiones:
- D7 — El filtrado y la selección por petición ocurren en el navegador: se poda el HAR
  y se envía solo el subconjunto elegido, así la ruta no necesita cambios.
- D8 — La vista previa usa los módulos compartidos (`importHar`, `harGraphToComposition`,
  `suggestHarVariables`) del lado del cliente; `apps/web/app/editor/page.tsx` ya consume
  `@k6flow/shared` en el navegador, así que es el mismo patrón.
- D9 — La lógica de filtrado/poda va en un módulo puro con tests; la página solo compone.

- [x] T8a Módulo puro `har-preview.ts`: clasificar/filtrar entradas (tipo, método, rango
      de estado, dominio, texto), podar el HAR conservando `log` y `pages`, resumen y
      contadores. Tests.
- [x] T8b Página `/import`: subir archivo, tabla de peticiones con casillas, filtros,
      panel de variables sugeridas, nombre del escenario y confirmación que hace POST a
      `/api/import/har` y muestra el resultado enlazando al editor.

### T8 — evidencia

`har-preview.ts` (247 líneas, 30 tests) + `app/import/page.tsx` (893 líneas). La página
lee el archivo en el navegador, valida, muestra la tabla con casillas, filtra como
DevTools, sugiere variables y hace POST solo con el subconjunto elegido (visible ∧
marcado), sin tocar la ruta. Verificado por el padre: 30 tests focales, `pnpm test`
**2057**, typecheck 0, build 0 con `○ /import`.

Fuera de alcance declarado: enlace de navegación en el sidebar, tests de navegador y
partir la página en componentes.

