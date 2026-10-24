# K6Flow — espera configurable entre peticiones (connection wait)

Feature: cada conexión del grafo puede llevar un tiempo de espera que se traduce
al script de k6 como `sleep()`. Rama `feat/connection-wait`.

## Specs

S1 — La espera se configura en la conexión, no en el nodo.
> "cuando cree estas conceciones  tambien se le pueda crerar una de algua forma un valor que sea el timpo de espera entre peticion y peticion"

S2 — El valor se traduce al script generado de k6.
> "queeste se deb traducir a el escrio de k6"

S3 — Se configura en segundos o minutos.
> "ademas debe poder configurar en segundos o mininutos de cuanto tiempo de espera hay entre petiones"

## Decisiones de diseño

- D1 — La espera vive en `connections[].waitSeconds`, porque las flechas del
  usuario apuntan a las conexiones entre nodos.
- D2 — Se persiste **en segundos** (número, canónico). La UI ofrece segundos o
  minutos y convierte al guardar; nunca se persiste texto con unidad.
- D3 — Se emite como `sleep(<segundos>)` inmediatamente después de la petición
  del nodo de origen, una vez por conexión saliente.
- D4 — Ausente o `0` significa sin espera: los escenarios ya guardados siguen
  traduciéndose igual.
- D5 — Cota: `0 ≤ waitSeconds ≤ 3600`, finito. Fuera de rango se rechaza en el
  contrato, no en la UI.

## Tasks

- [x] T1 Contrato: `waitSeconds` opcional en `connections` de `graph.ts`, con
      validación de rango y tests (acepta válidos, rechaza negativos/infinito/fuera de rango, acepta ausente).
- [x] T2 Traductor: emitir `sleep()` por conexión saliente e importar `sleep`
      desde `k6` sólo cuando se usa; test del script generado.
- [x] T3 Mapeo editor: llevar `waitSeconds` del grafo a la arista y de vuelta,
      sin perderlo en el round-trip; tests de mapeo.
- [x] T4 UI: seleccionar una conexión y configurar la espera en segundos o
      minutos, mostrando el valor sobre la arista; tests de conversión.
- [ ] T5 Evidencia y cierre: suites verdes, doc actualizado.

## Log

L1 (pedido original, verbatim):
> ayudme con esta tarea para que cuando cree estas conceciones  tambien se le pueda crerar una de algua forma un valor que sea el timpo de espera entre peticion y peticion queeste se deb traducir a el escrio de k6 y ademas debe poder configurar en segundos o mininutos de cuanto tiempo de espera hay entre petiones

## Evidencia

| Rebanada | Commits | Líneas | Verificación |
| --- | --- | --- | --- |
| Contrato + traductor | `1860f16` | 115 | RED 2 fallos → 58/58 graph, 41/41 traductor, 853 shared, typecheck 0 |
| Editor (mapeo + UI) | `89cea68` | 323 | RED 2 fallos → 32/32 mapping, 8/8 connection-wait, 1900 tests totales, lint 0, build 0 |

Límite de rebanada declarado: la segunda unidad quedó en 323 líneas y el acumulado
en 438, por encima de las ~400 de guía. Se acepta como rebanada coherente: mapeo y
UI no se pueden separar sin dejar la mitad muerta (una arista que nadie puede editar),
y ambas son el mismo comportamiento.

Pendiente de verificación: la interacción real en el navegador (seleccionar una
conexión, escribir el valor, verlo en la arista y guardar) no se probó con un
navegador; sí se probó toda la lógica pura, el mapeo, el contrato y el script
generado.

L2: sin cambios de requerimientos; el usuario confirmó con "si dale arranca" que
avanzara con la implementación propuesta.

