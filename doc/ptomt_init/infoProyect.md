# K6Flow: Framework DevOps de Pruebas de Carga sobre K6

Fecha: 30 de septiembre de 2026

## 1. Objetivo y alcance

Herramienta propia de DevOps para pruebas de carga y rendimiento, desacoplada de cualquier producto de negocio específico (no atada a Match 360 ni a ningún otro). Debe servir para probar múltiples aplicaciones de la empresa de forma reutilizable: se instala una sola vez y cada nuevo escenario se resuelve configurando, sin reinstalar nada.

## 2. Arquitectura

- **Motor de ejecución:** K6 (open source), corriendo en contenedores Docker independientes, uno por prueba.
- **Configuración visual:** los escenarios se arman en un editor visual de nodos; el diagrama se traduce automáticamente a un script K6 en JavaScript.
- **Plantillas:** los escenarios se guardan y se reutilizan entre aplicaciones y productos.

## 3. Editor visual de nodos (React Flow)

- Librería: **React Flow** (la misma que usa n8n), elegida tras compararla con Vue Flow. El frontend va en React.
- Nodos arrastrables:
  - **Autenticación:** generar token (JWT, cookies u otros métodos).
  - **Petición HTTP.**
  - **Validación de respuesta.**
  - **Pool de usuarios de prueba:** carga de, por ejemplo, 100 usuarios con usuario/contraseña vía CSV, usando `SharedArray` de K6 para repartir las credenciales entre los usuarios virtuales.

## 3.1 Grabación de sesiones (entrada alternativa al editor)

- Además de armar la prueba nodo por nodo, el usuario puede **grabar un ciclo completo de navegación** contra la aplicación objetivo (en otra IP o dominio) y convertirlo automáticamente en un grafo de nodos, que luego edita y ajusta como cualquier otro.
- La grabación ocurre **del lado del servidor**: un navegador headless (Playwright o Puppeteer) corre en un contenedor dentro del VPS y se controla en remoto casi en vivo desde la interfaz web.
- Los frames del navegador se transmiten por WebSocket y se pintan en el frontend; cada clic o tecla del usuario viaja de vuelta por el mismo canal.
- Todo el tráfico que genera la página se captura y se traduce a nodos (transformación inversa a la de nodos a script K6).

## 4. Backend

- **Next.js:** toda la interfaz, el guardado de escenarios, la traducción del diagrama de nodos a script K6 y la autenticación de los usuarios de la herramienta.
- **Servicio orquestador separado en Go:** recibe el script K6 ya armado junto con la configuración del contenedor, y se comunica con el Docker Engine para lanzarlo y monitorearlo. Se separa porque es un proceso de larga duración que no encaja con las funciones serverless de Next.js; Go se eligió por su buen manejo de concurrencia y procesos de larga duración.
- **Comunicación de control (Next.js ↔ orquestador):** API REST para lanzar una prueba, detenerla y consultar su estado. Es tráfico interno de bajo volumen, y REST da mayor velocidad de desarrollo y depuración en esta etapa temprana (gRPC descartado por ahora).
- **Servicio de grabación separado en Node:** Playwright y Puppeteer están mejor soportados en ese ecosistema que en Go. Solo se enciende bajo demanda: el orquestador en Go lanza su contenedor al iniciar una grabación y lo apaga y elimina al terminar, para no gastar recursos del VPS. Al finalizar, la captura se entrega al orquestador.

## 5. Comunicación en tiempo real

- Tecnología: **WebSocket** (descartado SSE).
- Flujo: K6 escribe métricas en JSON en tiempo real → el orquestador en Go las parsea y las retransmite por WebSocket → el frontend las muestra en un dashboard en vivo (peticiones por segundo, latencia, errores).
- El WebSocket se reserva para las métricas en vivo; el control de las pruebas va por REST.

## 6. Empaquetado con Docker Compose

- Contenedores en el Compose: frontend Next.js, orquestador en Go y base de datos de escenarios.
- El orquestador lanza los contenedores K6 al vuelo, y también el contenedor del servicio de grabación, solo mientras dura cada grabación.
- Instalación con un solo comando.

## 7. Estrategia de repositorio

- **Monorepo** (frontend y orquestador muy entrelazados en esta etapa temprana).
- Separar en repositorios distintos solo si el equipo crece y cada pieza gana un ciclo de vida independiente.
