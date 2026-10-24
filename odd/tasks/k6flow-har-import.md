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
- D4 — Las variables (S4) quedan para una rebanada aparte: el importador no va a
  inventar placeholders hasta definir el plan de variables.
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

