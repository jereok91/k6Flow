---
name: DevOps Observability Precision
colors:
  surface: '#10141a'
  surface-dim: '#10141a'
  surface-bright: '#353940'
  surface-container-lowest: '#0a0e14'
  surface-container-low: '#181c22'
  surface-container: '#1c2026'
  surface-container-high: '#262a31'
  surface-container-highest: '#31353c'
  on-surface: '#dfe2eb'
  on-surface-variant: '#ccc3d8'
  inverse-surface: '#dfe2eb'
  inverse-on-surface: '#2d3137'
  outline: '#958da1'
  outline-variant: '#4a4455'
  surface-tint: '#d2bbff'
  primary: '#d2bbff'
  on-primary: '#3f008e'
  primary-container: '#7c3aed'
  on-primary-container: '#ede0ff'
  inverse-primary: '#732ee4'
  secondary: '#4cd7f6'
  on-secondary: '#003640'
  secondary-container: '#03b5d3'
  on-secondary-container: '#00424e'
  tertiary: '#d0bcff'
  on-tertiary: '#3c0091'
  tertiary-container: '#7645e0'
  on-tertiary-container: '#ece1ff'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#eaddff'
  primary-fixed-dim: '#d2bbff'
  on-primary-fixed: '#25005a'
  on-primary-fixed-variant: '#5a00c6'
  secondary-fixed: '#acedff'
  secondary-fixed-dim: '#4cd7f6'
  on-secondary-fixed: '#001f26'
  on-secondary-fixed-variant: '#004e5c'
  tertiary-fixed: '#e9ddff'
  tertiary-fixed-dim: '#d0bcff'
  on-tertiary-fixed: '#23005c'
  on-tertiary-fixed-variant: '#5516be'
  background: '#10141a'
  on-background: '#dfe2eb'
  surface-variant: '#31353c'
typography:
  display:
    fontFamily: Geist
    fontSize: 36px
    fontWeight: '600'
    lineHeight: 44px
    letterSpacing: -0.03em
  display-mobile:
    fontFamily: Geist
    fontSize: 28px
    fontWeight: '600'
    lineHeight: 36px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Geist
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Geist
    fontSize: 20px
    fontWeight: '500'
    lineHeight: 28px
    letterSpacing: -0.015em
  headline-sm:
    fontFamily: Geist
    fontSize: 16px
    fontWeight: '500'
    lineHeight: 24px
    letterSpacing: -0.01em
  body-lg:
    fontFamily: Geist
    fontSize: 15px
    fontWeight: '400'
    lineHeight: 24px
    letterSpacing: -0.005em
  body-md:
    fontFamily: Geist
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 20px
    letterSpacing: 0em
  body-sm:
    fontFamily: Geist
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 18px
    letterSpacing: 0.01em
  label-code-lg:
    fontFamily: JetBrains Mono
    fontSize: 13px
    fontWeight: '500'
    lineHeight: 20px
    letterSpacing: -0.01em
  label-code-md:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 18px
    letterSpacing: 0em
  label-code-sm:
    fontFamily: JetBrains Mono
    fontSize: 11px
    fontWeight: '400'
    lineHeight: 16px
    letterSpacing: 0.02em
  metric-huge:
    fontFamily: JetBrains Mono
    fontSize: 32px
    fontWeight: '600'
    lineHeight: 40px
    letterSpacing: -0.03em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  gutter: 1rem
  gutter-desktop: 1.25rem
  margin: 1rem
  margin-tablet: 1.5rem
  margin-desktop: 2rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 0.75rem
  space-lg: 1rem
  space-xl: 1.5rem
---

## Brand & Style

Este sistema de diseño canaliza una estética de herramienta de ingeniería de alto rendimiento para DevOps y pruebas de carga continua, combinando la sobriedad quirúrgica de entornos como Linear y Vercel con la densidad analítica de Grafana. 

El estilo visual se define como **Minimalismo Técnico de Alta Densidad**:
- **Personalidad:** Rigurosa, precisa, reactiva e imperturbable. Transmite la solidez de una terminal de control crítico.
- **Audiencia:** Ingenieros de confiabilidad de sitios (SREs), arquitectos cloud, desarrolladores backend y líderes de DevOps que valoran la velocidad por teclado, la legibilidad instantánea de métricas en tiempo real y la ausencia de ruido decorativo.
- **Respuesta emocional:** Control técnico absoluto, calma operativa durante picos de tráfico extremo y claridad visual frente al caos de telemetría.
- **Acabado estético:** Superficies carbón estratificadas en tres niveles, separadas por delineados nítidos de 1px, con acentos luminiscentes hiperenfocados para guiar el flujo de ejecución sin deslumbrar.

## Colors

La paleta se apoya en una arquitectura cromática de modo oscuro estricto, diseñada para jornadas operativas extensas y visualización nocturna en centros de control:

- **Lienzo y Superficies:**
  - Base de lienzo: `#0d1117` (Negro carbón profundo).
  - Contenedores y paneles intermedios: `#161b22` (Carbón medio).
  - Superficies elevadas, cabeceras y tarjetas: `#21262d` (Gris antracita).
  - Bordes y separadores técnicos: `#30363d` (Gris delimitador neutro).

- **Acentos Primarios y Secundarios:**
  - Primario (`#7c3aed`) y Primario Hover/Glow (`#8b5cf6`): Violeta eléctrico reservado para acciones maestras (despliegue de pruebas, ejecuciones masivas y focos de selección activa).
  - Secundario / Telemetría activa (`#06b6d4`): Cian vívido para flujos de datos en tiempo real, trazado de curvas VUs (Virtual Users) y enlaces activos de depuración.

- **Semántica de Estado DevOps:**
  - Éxito / Estado Saludable: `#10b981` (Esmeralda puro para p95 dentro de SLA, tests superados y nodos online).
  - Advertencia / Umbral Crítico: `#f59e0b` (Ámbar para saturación de memoria, latencias elevadas y límites próximos).
  - Error / Peligro / Abortar: `#f43f5e` (Carmesí intenso para HTTP 5xx, cuellos de botella severos y comandos destructivos).
  - Reposo / Inactivo: `#64748b` (Pizarra para jobs terminados, nodos desconectados y métricas secundarias).

- **Texto y Jerarquía:**
  - Primario: `#f0f6fc` (95% luminancia para máxima legibilidad).
  - Secundario: `#8b949e` (Para metadatos, unidades de medida y timestamps).
  - Terciario / Deshabilitado: `#484f58`.

## Typography

La selección tipográfica separa deliberadamente la interfaz narrativa de los datos crudos de ejecución:

- **Interfaz de Usuario y Títulos (`Geist`):** Proporciona neutralidad rigurosa, proporciones contemporáneas y legibilidad compacta. Se emplea en encabezados, navegación, descripciones y modales de configuración.
- **Datos Técnicos, Identificadores y Métricas (`JetBrains Mono`):** Diseñada para la lectura ágil de números, scripts de prueba, rutas HTTP (`GET /api/v1/checkout`), identificadores UUID y contadores de rendimiento en tiempo real (RPS, p99, latencias milimétricas). Sus caracteres monospaciados evitan el salto visual durante el refresco de métricas en directo.
- **Tratamiento tipográfico:** Títulos siempre en tracking ligeramente negativo (`-0.02em` a `-0.03em`) para un anclaje compacto y autoritario. Las métricas utilizan `metric-huge` para garantizar lecturas inequívocas a distancia.

## Layout & Spacing

El sistema implementa una retícula fluida estructurada en 12 columnas en escritorio y adaptativa en pantallas menores, optimizada para dashboards modulares estilo Grafana con paneles configurables en cuadrícula:

- **Estructura de Cuadrícula:**
  - **Escritorio (>1200px):** 12 columnas con canales (`gutter-desktop`) de `1.25rem` (20px) y márgenes perimetrales de `2rem` (32px). Permite distribuciones asimétricas (sidebar técnico de 240px fijo, área de trabajo central en 8 columnas y consola lateral en 4 columnas).
  - **Tableta (768px - 1199px):** 8 columnas con canales de `1rem` (16px) y márgenes de `1.5rem` (24px). La consola lateral pasa a panel inferior colapsable.
  - **Móvil (<768px):** 4 columnas fluidas con márgenes de `1rem` (16px) y apilado vertical estricto de tarjetas de métrica.

- **Ritmo de Espaciado (Layout & Densidad):**
  - Se favorece la densidad informativa compacta sobre espacios vacíos excesivos. 
  - `space-xs` (4px) se reserva para espaciado micro entre etiquetas técnicas e iconos.
  - `space-sm` (8px) define el padding interno estándar de celdas de tabla e inputs.
  - `space-md` (12px) y `space-lg` (16px) gestionan el padding de tarjetas de visualización gráfica y bloques de código.

## Elevation & Depth

En concordancia con el minimalismo técnico moderno, la tridimensionalidad se resuelve mediante **capas tonales combinadas con delineados de bajo contraste de 1px**, eliminando sombras difusas pesadas:

- **Nivel 0 (Lienzo / Background):** `#0d1117`. Fondo base de la aplicación.
- **Nivel 1 (Paneles estructurales y barras de herramientas):** `#161b22`, delimitado por un borde sólido continuo `1px solid #30363d`.
- **Nivel 2 (Tarjetas de métricas, editores y tablas):** `#21262d`. Destacan sutilmente contra el fondo intermedio manteniendo contraste técnico.
- **Nivel 3 (Modales de configuración de carga y Popovers de inspección):** Superficie `#21262d` con sombra ambiental atenuada (`0 12px 32px rgba(0, 0, 0, 0.6)`) y borde reforzado en `#30363d`.
- **Iluminación Reactiva (Glow Acentuado):** Los elementos en ejecución activa (como un botón de prueba en curso o un nodo emisor) proyectan un halo electroluminiscente controlado: `box-shadow: 0 0 12px rgba(124, 58, 237, 0.35)`.

## Shapes

El lenguaje de formas opta por esquinas contenidas de carácter pragmático e industrial:

- **Nivel de Redondez:** Soft (`1`), donde el estándar base para botones, tarjetas, bloques de código, chips de métricas y campos de entrada es de `0.25rem` (4px) a `0.5rem` (8px en contenedores mayores).
- **Contenedores y Tarjetas (`rounded-lg`):** `0.5rem` (8px exactos). Confiere un contorno contemporáneo sin caer en formas redondeadas o lúdicas.
- **Modales y Diálogos Flotantes (`rounded-xl`):** `0.75rem` (12px), limitados exclusivamente a capas superpuestas.
- **Bordes Activos:** Todas las esquinas redondeadas están acompañadas por un trazo perimetral de `1px` uniforme en `#30363d` para acentuar el rigor geométrico.

## Components

- **Botones (Buttons):**
  - *Primario (Iniciar Prueba / Guardar Pipeline):* Fondo `#7c3aed`, texto `#ffffff`, esquina `0.5rem`. Al hover: fondo `#8b5cf6` con glow sutil `0 0 10px rgba(139, 92, 246, 0.4)`. Al clic/activo: escala 0.98.
  - *Secundario / Contorno:* Fondo transparente, borde `1px solid #30363d`, texto `#f0f6fc`. Hover: fondo `#161b22`, borde `#8b949e`.
  - *Destructivo / Abortar Carga:* Fondo `#21262d`, borde `1px solid rgba(244, 63, 94, 0.4)`, texto `#f43f5e`. Hover: fondo `#f43f5e`, texto `#ffffff`.
  - *Icono con atajo de teclado:* Contiene la tecla rápida en fuente mono (`⌘K` o `R`) en color `#8b949e`.

- **Tarjetas de Rendimiento y Gráficos (Cards):**
  - Fondo `#161b22`, borde `1px solid #30363d`, radio de curvatura `8px`, relleno interno `16px`.
  - Encabezado con título de la métrica en `Geist 13px #8b949e` junto con el endpoint evaluado en `JetBrains Mono 12px`.
  - Indicador de estado en esquina superior derecha (punto pulsante de 6px en `#10b981` durante streaming de datos).

- **Insignias y Chips de Estado (Badges):**
  - Estructura compacta: altura de 20px, radio de curvatura de `4px`, padding horizontal de 6px.
  - Tipografía monospaciada en `11px`.
  - *Éxito:* Fondo `rgba(16, 185, 129, 0.1)`, texto `#10b981`, borde `1px solid rgba(16, 185, 129, 0.3)`.
  - *Alerta:* Fondo `rgba(245, 158, 11, 0.1)`, texto `#f59e0b`, borde `1px solid rgba(245, 158, 11, 0.3)`.
  - *Error:* Fondo `rgba(244, 63, 94, 0.1)`, texto `#f43f5e`, borde `1px solid rgba(244, 63, 94, 0.3)`.

- **Campos de Entrada y Editores de Carga (Inputs):**
  - Fondo `#0d1117`, borde `1px solid #30363d`, texto `#f0f6fc` en tipografía mono para URLs y scripts.
  - Estado Focus: borde `1px solid #7c3aed`, anillo exterior sin desenfoque `0 0 0 1px #7c3aed`.
  - Prefijos fijos para protocolos técnicos (`https://`, `grpc://`) estilizados en `#484f58`.

- **Listas y Tablas de Telemetría (Lists & Data Tables):**
  - Filas de tabla con altura fija compacta (36px a 40px), separadas por líneas de `1px solid #21262d`.
  - Estados hover en filas: iluminación de fondo a `#161b22`.
  - Alineación estricta a la derecha para columnas numéricas (latencia media, throughput, tasa de error) en `JetBrains Mono`.

- **Interruptores y Casillas de Verificación (Checkboxes & Switches):**
  - Checkbox: caja de `16x16px`, borde `#30363d`, fondo `#0d1117`, radio `3px`. Marcado: fondo `#7c3aed` con tick blanco vectorizado.
  - Switch de activación de monitores: pista de fondo `#21262d` con tirador deslizante en blanco `#f0f6fc`; al activarse, la pista transmuta a `#7c3aed`.

- **Consola de Registros en Vivo (Terminal Output):**
  - Superficie `#0d1117` con borde `#30363d`, padding interno de `12px`, tipografía `JetBrains Mono 12px`, timestamps en color `#64748b` y resaltado de sintaxis JSON nativo con variables de consulta.