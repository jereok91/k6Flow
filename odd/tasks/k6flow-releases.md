# K6Flow — Releases (tag → imágenes publicadas)

Alcance: cortar una versión con un tag `vX.Y.Z`, publicar las imágenes en GHCR y dejar un
`docker compose` que cualquiera pueda levantar con `docker compose up -d` sin clonar el repo.

## Specs

S1 (verbatim, user): "quiero poder ir sacando releases a partir de tag versiones, que se
disponibilicen y que las personas puedan usar dichas compilaciones en docker compose algo como
hace https://github.com/jhaals/yopass … `image: jhaals/yopass`"
  - Un usuario final levanta K6Flow con un compose que sólo referencia imágenes publicadas, sin
    build local ni checkout del repositorio.

S2 (verbatim, user): "puede ser con github register o con docker, creo que es mas facil hacerlo en
este momento con google register" → decisión registrada: **GHCR** (`ghcr.io/jereok91/k6flow-*`),
autenticado con `GITHUB_TOKEN`, sin secretos nuevos.

S3 (verbatim, user): "este flujo debe ejecutarse solo cuando vaya por" (frase cortada) →
decisión registrada: el release corre **sólo** en el push de un tag `vX.Y.Z`.

S4 (verbatim, user): "dejar muchos ejemplo claros de lo que debo hacer" → `docs/RELEASES.md` con
el paso a paso del mantenedor y del usuario, incluidos ejemplos copy-paste.

S5 (decisión): por versión se publican `1.2.3`, `1.2`, `1` y `latest`.

S6 (decisión): el esquema de la base lo aplica un servicio `setup` del compose de release, que
corre migraciones + seed del admin y termina; `web` arranca sólo si terminó bien.

## Tasks

- T1 — Runner de setup: extraer el seed a una función reutilizable y agregar
  `scripts/release-setup.ts` (migraciones + seed) con su stage `setup` en el Dockerfile del web.
- T2 — `deploy/docker-compose.release.yml`: stack que sólo referencia imágenes publicadas, con
  `setup` gateando a `web`.
- T3 — `.github/workflows/release.yml`: tag `vX.Y.Z` → build y push de las 4 imágenes a GHCR con
  los tags semver.
- T4 — `docs/RELEASES.md`: cómo cortar una versión y cómo la corre un usuario.
- T5 — Gate: el compose de release se valida en CI para que no se pudra.
- T6 — Verificación: `docker compose config`, build del stage `setup` y migración + seed contra una
  base limpia.

## Log

- L1 (user, verbatim): "ahora qiero poder ir sacando releeses apartir de tag versiones, que se
  diponibilicen y que las perosas puedan usar dichas compilaiones en docker compose alogo como hace
  https://github.com/jhaals/yopass … puede ser con githuib register o con docker, creo que es mas
  facil hacerlo ene ste momento con google register tratar de dejar muchos ejmplo claros de lo que
  debo hacer. este flujo debe ejcutarse solo cuando vaya por"
- L2 (decisions, answered by the owner): GHCR · trigger = push de tag `vX.Y.Z` · tags `1.2.3`
  `1.2` `1` `latest` · migraciones en un servicio `migrate` del compose.
- L3 (evidence): la imagen `production` del web sólo contiene el standalone de Next y no trae
  migraciones ni seed; el seed es un CLI explícito (no auto-seed por diseño), así que un usuario
  nuevo no podría ni loguearse. El orchestrator necesita `/var/run/docker.sock` y la red de k6: se
  documenta como requisito, no se oculta.
- L4 (deviation, justified): el servicio de setup necesita TS + el código de `apps/web` (seed y
  hash de password), así que se publica una cuarta imagen `k6flow-setup` construida desde el stage
  `setup` del mismo Dockerfile. Mantiene una sola fuente de verdad para migraciones y hashing en
  lugar de duplicar scrypt en un script JS.
