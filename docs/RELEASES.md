# Releases

K6Flow publica imágenes en **GHCR** (`ghcr.io/jereok91/k6flow-*`) cada vez que se pushea un tag de
versión. Con esas imágenes, cualquiera levanta la aplicación con un `docker compose` sin clonar
el repositorio.

## Imágenes por versión

| Imagen | Qué es | Para qué |
|---|---|---|
| `ghcr.io/jereok91/k6flow-web` | Next.js (target `production`) | UI + API |
| `ghcr.io/jereok91/k6flow-orchestrator` | Go | Ejecuta y monitorea los k6 |
| `ghcr.io/jereok91/k6flow-recorder` | Playwright | Grabador visual |
| `ghcr.io/jereok91/k6flow-setup` | Migraciones + seed del admin | Se corre una vez por deploy |

Cada versión publica **cuatro tags** por imagen: `1.2.3`, `1.2`, `1` y `latest`.

---

## Para el mantenedor: cortar una release

```bash
# 1. Verificá que main esté verde en CI
gh run list --branch main --limit 1

# 2. Creá el tag sobre el commit que querés publicar
git checkout main && git pull
git tag v1.2.3

# 3. Pusheá el tag: esto dispara el workflow "Release images"
git push origin v1.2.3
```

Qué pasa después:

1. El workflow valida que el tag sea `vX.Y.Z` (si no, falla antes de construir nada).
2. Construye las cuatro imágenes en paralelo y las pública con los cuatro tags.
3. Las imágenes quedan visibles en `https://github.com/jereok91?tab=packages`.

Si te equivocaste de versión, no borres el tag: publicá la siguiente (`v1.2.4`) y dejá el anterior;
las imágenes son inmutables para quien fijó versión.

### Cómo verificar que salió bien

```bash
docker pull ghcr.io/jereok91/k6flow-web:1.2.3
docker run --rm ghcr.io/jereok91/k6flow-recorder:1.2.3 node -e "console.log('recorder listo')"
```

Cuando el paquete es público, el `docker pull` no necesita login. Si el paquete quedó privado,
hacé público el paquete en GitHub → Packages, o el usuario debe loguearse:

```bash
echo "$GITHUB_TOKEN" | docker login ghcr.io -u <usuario> --password-stdin
```

---

## Para el usuario: levantar K6Flow con las imágenes

### Opción A — versión fija (recomendado)

```bash
mkdir k6flow && cd k6flow
curl -O https://raw.githubusercontent.com/jereok91/k6Flow/main/deploy/docker-compose.release.yml

cat > .env <<'EOF'
POSTGRES_PASSWORD=cambia-esta-clave
ADMIN_USERNAME=admin
ADMIN_PASSWORD=cambia-esta-clave-de-12-o-mas
K6FLOW_VERSION=1.2.3
EOF

docker compose -f docker-compose.release.yml up -d
```

Abrí `http://localhost:3000` y entrá con `ADMIN_USERNAME` / `ADMIN_PASSWORD`.

### Opción B — siempre la última

```bash
# sin K6FLOW_VERSION en el .env, las imágenes quedan en :latest
docker compose -f docker-compose.release.yml pull
docker compose -f docker-compose.release.yml up -d
```

### Opción C — pegar el compose dentro de tu propio repo

```yaml
services:
  k6flow:
    image: ghcr.io/jereok91/k6flow-web:1.2.3
    ports:
      - "3000:3000"
    environment:
      DATABASE_URL: postgresql://k6flow:secret@db:5432/k6flow
      ORCHESTRATOR_INTERNAL_URL: http://orchestrator:8080
      ORCHESTRATOR_SERVICE_TOKEN: cambia-esto
      RECORDER_UPSTREAM: http://recorder:8081
      RECORDER_AUTH_TOKEN: cambia-esto
    depends_on:
      db: { condition: service_healthy }
      setup: { condition: service_completed_successfully }

  setup:
    image: ghcr.io/jereok91/k6flow-setup:1.2.3
    environment:
      DATABASE_URL: postgresql://k6flow:secret@db:5432/k6flow
      ADMIN_USERNAME: admin
      ADMIN_PASSWORD: cambia-esto-de-12-o-mas
    depends_on:
      db: { condition: service_healthy }
    restart: "no"

  orchestrator:
    image: ghcr.io/jereok91/k6flow-orchestrator:1.2.3
    environment:
      SERVICE_TOKEN: cambia-esto
      ORCHESTRATOR_NETWORK: k6flow_k6runner
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock

  recorder:
    image: ghcr.io/jereok91/k6flow-recorder:1.2.3
    environment:
      AUTH_TOKEN: cambia-esto

  db:
    image: postgres:17.7-alpine3.22
    environment:
      POSTGRES_DB: k6flow
      POSTGRES_USER: k6flow
      POSTGRES_PASSWORD: secret
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: [CMD-SHELL, 'pg_isready -U k6flow -d k6flow']
      interval: 5s
      retries: 12

volumes:
  postgres-data: {}
```

> Si renombrás el proyecto (`name:`), el orchestrator necesita
> `ORCHESTRATOR_NETWORK: <nombre-del-proyecto>_k6runner`.

### Variables que podés tocar

| Variable | Default | Para qué |
|---|---|---|
| `K6FLOW_VERSION` | `latest` | Versión de las cuatro imágenes |
| `K6FLOW_REGISTRY` | `ghcr.io/jereok91` | Cambialo si hacés fork y publicás en tu cuenta |
| `WEB_PORT` | `3000` | Puerto publicado del web |
| `POSTGRES_PASSWORD` | — (obligatoria) | Clave de la base |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / — (obligatoria, mínimo 12) | Usuario inicial |
| `ORCHESTRATOR_SERVICE_TOKEN` | `k6flow-internal-token` | Token interno web ↔ orchestrator |
| `RECORDER_AUTH_TOKEN` | `k6flow-internal-token` | Token interno web ↔ recorder |
| `MAX_VUS_PER_RUN` / `MAX_MEMORY_MIB_PER_RUN` / `MAX_CPU_MILLIS_PER_RUN` | `500` / `4096` / `4000` | Topes por ejecución |
| `ALLOWED_TARGETS` | vacío | Hosts permitidos para las pruebas |

### Qué hace el servicio `setup`

1. Aplica las migraciones pendientes (idempotente).
2. Crea o actualiza el usuario admin con `ADMIN_USERNAME` / `ADMIN_PASSWORD`.
3. Termina con código 0. El servicio `web` sólo arranca cuando terminó bien.

Si cambiás `ADMIN_PASSWORD`, volvé a correrlo y la clave se actualiza:

```bash
docker compose -f docker-compose.release.yml run --rm setup
```

---

## Actualizar a una versión nueva

```bash
# 1. Cambiá la versión en el .env
sed -i 's/^K6FLOW_VERSION=.*/K6FLOW_VERSION=1.3.0/' .env

# 2. Bajá las imágenes y recreá los servicios (setup vuelve a correr y migra)
docker compose -f docker-compose.release.yml pull
docker compose -f docker-compose.release.yml up -d
```

La base queda en el volumen `k6flow_postgres-data`, así que las migraciones se aplican encima de
tus datos.

## Requisitos y problemas frecuentes

- **Docker con acceso al socket**: el orchestrator lanza un contenedor k6 por ejecución, por eso
  monta `/var/run/docker.sock`. Sin eso, las ejecuciones fallan aunque la UI funcione.
- **`setup` falla con "Missing required environment variable"**: falta `ADMIN_PASSWORD` (mínimo 12
  caracteres) o `DATABASE_URL`.
- **El login no acepta la clave**: verificá que `setup` haya corrido
  (`docker compose -f docker-compose.release.yml logs setup`).
- **`denied` al bajar imágenes**: el paquete está privado; hacelo público o logueate en `ghcr.io`.
- **No quiero exponer 3000**: quitá la sección `ports` del `web` y poné un reverse proxy (Caddy,
  Traefik, nginx) delante de `k6flow-web:3000`.
