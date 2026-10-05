"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { MainLayout } from "../lib/layout";

interface Scenario {
  id: string;
  name: string;
  updatedAt: string;
}

interface Recording {
  id: string;
  name: string;
  createdAt: string;
  stepCount: number;
}

export default function HomePage() {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch("/api/scenarios?limit=5").then((r) => r.json()),
      fetch("/api/recordings?limit=5").then((r) => r.json()),
    ])
      .then(([scenariosData, recordingsData]) => {
        setScenarios(scenariosData.scenarios || []);
        setRecordings(recordingsData.recordings || []);
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <MainLayout>
      <div className="flex flex-col w-full">
        {/* Ambient glow effects */}
        <div className="relative w-full overflow-hidden px-gutter-desktop py-space-xl flex flex-col gap-space-xl">
          <div className="absolute -top-32 right-12 w-96 h-96 bg-primary-container/10 rounded-full blur-3xl pointer-events-none -z-10" />
          <div className="absolute top-1/2 -left-20 w-80 h-80 bg-secondary/5 rounded-full blur-3xl pointer-events-none -z-10" />

          {/* Header Section */}
          <section className="flex flex-col md:flex-row md:items-end justify-between gap-space-lg">
            <div className="flex flex-col gap-space-xs">
              <div className="flex items-center gap-space-sm text-label-code-sm text-on-surface-variant uppercase tracking-wider">
                <span className="w-2 h-2 rounded-full bg-secondary" />
                <span>Workspace Activo // Local</span>
                <span className="text-outline-variant">/</span>
                <span className="text-primary font-medium">Development</span>
              </div>
              <h1 className="text-headline-lg text-on-surface font-semibold tracking-tight">
                Panel de Control de Pruebas
              </h1>
              <p className="text-body-md text-on-surface-variant max-w-2xl">
                Graba sesiones de navegador, diseña escenarios de carga y ejecuta pruebas k6 en tiempo real.
              </p>
            </div>

            {/* Time filters */}
            <div className="flex items-center gap-space-sm flex-wrap">
              <div className="inline-flex p-1 bg-surface-container-low rounded-xl">
                <button
                  type="button"
                  className="px-space-md py-1 rounded-lg text-body-sm bg-surface-container-high text-on-surface font-medium shadow-sm"
                >
                  Últimos 7 días
                </button>
                <button
                  type="button"
                  className="px-space-md py-1 rounded-lg text-body-sm text-on-surface-variant hover:text-on-surface transition-colors"
                >
                  24 horas
                </button>
                <button
                  type="button"
                  className="px-space-md py-1 rounded-lg text-body-sm text-on-surface-variant hover:text-on-surface transition-colors"
                >
                  30 días
                </button>
              </div>
            </div>
          </section>

          {/* Metrics Row */}
          <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-space-md">
            {/* Metric 1: Scenarios */}
            <div className="metric-card">
              <div className="flex items-start justify-between">
                <div className="flex flex-col gap-space-xs">
                  <span className="text-body-sm text-on-surface-variant">Escenarios</span>
                  <span className="text-label-code-sm text-outline">Total activos</span>
                </div>
                <div className="w-8 h-8 rounded-lg bg-surface-container-high flex items-center justify-center text-primary">
                  <span className="material-symbols-outlined text-[18px]">account_tree</span>
                </div>
              </div>
              <div className="mt-space-md flex items-baseline gap-space-xs">
                <span className="text-metric-huge text-on-surface font-mono">
                  {loading ? "-" : scenarios.length}
                </span>
              </div>
            </div>

            {/* Metric 2: Recordings */}
            <div className="metric-card">
              <div className="flex items-start justify-between">
                <div className="flex flex-col gap-space-xs">
                  <span className="text-body-sm text-on-surface-variant">Grabaciones</span>
                  <span className="text-label-code-sm text-outline">Sesiones capturadas</span>
                </div>
                <div className="w-8 h-8 rounded-lg bg-surface-container-high flex items-center justify-center text-secondary">
                  <span className="material-symbols-outlined text-[18px]">videocam</span>
                </div>
              </div>
              <div className="mt-space-md flex items-baseline gap-space-xs">
                <span className="text-metric-huge text-on-surface font-mono">
                  {loading ? "-" : recordings.length}
                </span>
              </div>
            </div>

            {/* Metric 3: Live */}
            <div className="metric-card">
              <div className="flex items-start justify-between">
                <div className="flex flex-col gap-space-xs">
                  <span className="text-body-sm text-on-surface-variant">En ejecución</span>
                  <span className="text-label-code-sm text-outline">Pruebas activas</span>
                </div>
                <span className="relative flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-secondary opacity-75" />
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-secondary" />
                </span>
              </div>
              <div className="mt-space-md flex items-baseline gap-space-xs">
                <span className="text-metric-huge text-secondary font-mono">0</span>
                <span className="text-label-code-sm text-on-surface-variant">activas</span>
              </div>
            </div>

            {/* Metric 4: Status */}
            <div className="metric-card">
              <div className="flex items-start justify-between">
                <div className="flex flex-col gap-space-xs">
                  <span className="text-body-sm text-on-surface-variant">Estado del sistema</span>
                  <span className="text-label-code-sm text-outline">Servicios</span>
                </div>
                <div className="w-8 h-8 rounded-lg bg-surface-container-high flex items-center justify-center text-on-surface">
                  <span className="material-symbols-outlined text-[18px]">check_circle</span>
                </div>
              </div>
              <div className="mt-space-md flex items-center gap-space-xs">
                <span className="text-headline-md font-semibold text-secondary">Online</span>
                <span className="badge-success">OK</span>
              </div>
            </div>
          </section>

          {/* Quick Actions */}
          <section className="flex flex-col gap-space-md">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-space-sm">
                <span className="text-label-code-sm text-secondary uppercase tracking-wider">
                  // Acción inmediata
                </span>
                <span className="text-headline-sm text-on-surface font-medium">Accesos Rápidos</span>
              </div>
              <span className="text-label-code-sm text-on-surface-variant">
                Atajos de ingeniería k6
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-space-md">
              {/* Action 1: Create scenario */}
              <Link href="/editor" className="card group">
                <div className="flex items-start justify-between mb-space-md">
                  <div className="w-10 h-10 rounded-lg bg-surface-container-high flex items-center justify-center text-primary group-hover:bg-primary-container group-hover:text-on-primary-container transition-colors">
                    <span className="material-symbols-outlined text-[22px]">account_tree</span>
                  </div>
                  <span className="badge-success">Visual Builder</span>
                </div>
                <h3 className="text-headline-sm text-on-surface font-medium mb-space-xs">
                  Crear escenario desde cero
                </h3>
                <p className="text-body-sm text-on-surface-variant mb-space-md">
                  Diseña pruebas de carga conectando nodos visuales en el canvas interactivo con protocolos HTTP/2 y WebSockets.
                </p>
                <div className="flex items-center gap-space-xs text-primary text-body-sm font-medium group-hover:gap-space-sm transition-all">
                  <span>Abrir Canvas Studio</span>
                  <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
                </div>
              </Link>

              {/* Action 2: Record session */}
              <Link href="/recorder" className="card group">
                <div className="flex items-start justify-between mb-space-md">
                  <div className="w-10 h-10 rounded-lg bg-surface-container-high flex items-center justify-center text-secondary group-hover:bg-secondary-container group-hover:text-on-secondary-container transition-colors">
                    <span className="material-symbols-outlined text-[22px]">fiber_manual_record</span>
                  </div>
                  <span className="badge-success">HAR Proxy</span>
                </div>
                <h3 className="text-headline-sm text-on-surface font-medium mb-space-xs">
                  Grabar sesión con navegador
                </h3>
                <p className="text-body-sm text-on-surface-variant mb-space-md">
                  Navega en tu app web a través de un Chromium remoto y genera automáticamente los nodos HTTP y headers de autenticación.
                </p>
                <div className="flex items-center gap-space-xs text-secondary text-body-sm font-medium group-hover:gap-space-sm transition-all">
                  <span>Iniciar grabador web</span>
                  <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
                </div>
              </Link>

              {/* Action 3: View library */}
              <Link href="/scenarios" className="card group">
                <div className="flex items-start justify-between mb-space-md">
                  <div className="w-10 h-10 rounded-lg bg-surface-container-high flex items-center justify-center text-on-surface group-hover:bg-surface-container-highest transition-colors">
                    <span className="material-symbols-outlined text-[22px]">compare_arrows</span>
                  </div>
                  <span className="px-2 py-0.5 rounded-lg bg-surface-container-high text-on-surface-variant text-label-code-sm">
                    Biblioteca
                  </span>
                </div>
                <h3 className="text-headline-sm text-on-surface font-medium mb-space-xs">
                  Explorar escenarios
                </h3>
                <p className="text-body-sm text-on-surface-variant mb-space-md">
                  Revisa, edita y ejecuta tus escenarios guardados. Exporta scripts k6 listos para CI/CD.
                </p>
                <div className="flex items-center gap-space-xs text-on-surface text-body-sm font-medium group-hover:gap-space-sm transition-all">
                  <span>Ver biblioteca</span>
                  <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
                </div>
              </Link>
            </div>
          </section>

          {/* Recent Items */}
          <section className="grid grid-cols-1 lg:grid-cols-2 gap-space-lg">
            {/* Recent Scenarios */}
            <div className="flex flex-col gap-space-md">
              <div className="flex items-center justify-between">
                <h2 className="text-headline-sm text-on-surface font-medium">Escenarios Recientes</h2>
                <Link
                  href="/scenarios"
                  className="text-body-sm text-secondary hover:text-primary transition-colors"
                >
                  Ver todos →
                </Link>
              </div>
              <div className="card p-0 overflow-hidden">
                {loading ? (
                  <div className="p-space-lg text-center text-on-surface-variant">Cargando...</div>
                ) : scenarios.length === 0 ? (
                  <div className="p-space-lg text-center text-on-surface-variant">
                    No hay escenarios aún.{" "}
                    <Link href="/editor" className="text-primary hover:underline">
                      Crear uno
                    </Link>
                  </div>
                ) : (
                  <div className="divide-y divide-surface-container">
                    {scenarios.map((scenario) => (
                      <Link
                        key={scenario.id}
                        href={`/scenarios/${scenario.id}`}
                        className="flex items-center justify-between p-space-md hover:bg-surface-container transition-colors"
                      >
                        <div className="flex items-center gap-space-md">
                          <span className="material-symbols-outlined text-primary text-[18px]">
                            account_tree
                          </span>
                          <span className="text-body-md text-on-surface">{scenario.name}</span>
                        </div>
                        <span className="text-label-code-sm text-on-surface-variant font-mono">
                          {new Date(scenario.updatedAt).toLocaleDateString()}
                        </span>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Recent Recordings */}
            <div className="flex flex-col gap-space-md">
              <div className="flex items-center justify-between">
                <h2 className="text-headline-sm text-on-surface font-medium">Grabaciones Recientes</h2>
                <Link
                  href="/recordings"
                  className="text-body-sm text-secondary hover:text-primary transition-colors"
                >
                  Ver todas →
                </Link>
              </div>
              <div className="card p-0 overflow-hidden">
                {loading ? (
                  <div className="p-space-lg text-center text-on-surface-variant">Cargando...</div>
                ) : recordings.length === 0 ? (
                  <div className="p-space-lg text-center text-on-surface-variant">
                    No hay grabaciones aún.{" "}
                    <Link href="/recorder" className="text-secondary hover:underline">
                      Grabar una sesión
                    </Link>
                  </div>
                ) : (
                  <div className="divide-y divide-surface-container">
                    {recordings.map((recording) => (
                      <Link
                        key={recording.id}
                        href={`/recorder/review?id=${recording.id}`}
                        className="flex items-center justify-between p-space-md hover:bg-surface-container transition-colors"
                      >
                        <div className="flex items-center gap-space-md">
                          <span className="material-symbols-outlined text-secondary text-[18px]">
                            videocam
                          </span>
                          <div className="flex flex-col">
                            <span className="text-body-md text-on-surface">{recording.name}</span>
                            <span className="text-label-code-sm text-on-surface-variant">
                              {recording.stepCount} pasos
                            </span>
                          </div>
                        </div>
                        <span className="text-label-code-sm text-on-surface-variant font-mono">
                          {new Date(recording.createdAt).toLocaleDateString()}
                        </span>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* Workflow Guide */}
          <section className="card bg-surface-container-lowest border-surface-container">
            <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-space-lg">
              <div className="flex flex-col gap-space-xs">
                <div className="flex items-center gap-space-sm">
                  <span className="material-symbols-outlined text-primary text-[20px]">
                    electric_bolt
                  </span>
                  <span className="text-label-code-sm text-on-surface-variant uppercase tracking-wider">
                    Flujo de trabajo K6Flow
                  </span>
                </div>
                <h3 className="text-headline-sm text-on-surface font-medium">
                  Guía de inicio rápido
                </h3>
                <p className="text-body-sm text-on-surface-variant">
                  Asegura la escalabilidad de tus despliegues siguiendo los cuatro pasos del ciclo de prueba continuo.
                </p>
              </div>

              <div className="grid grid-cols-2 lg:grid-cols-4 gap-space-md">
                {[
                  { step: 1, icon: "settings_ethernet", title: "Conectar destino", desc: "Añade endpoints DNS, clusters k8s o ingress gateways." },
                  { step: 2, icon: "account_tree", title: "Modelar escenario", desc: "Configura ramp-up de VUs, stages de carga y payloads." },
                  { step: 3, icon: "speed", title: "Definir umbrales", desc: "Establece límites de SLAs (p95 < 200ms, fallas < 1%)." },
                  { step: 4, icon: "bar_chart", title: "Analizar métricas", desc: "Inspecciona cuellos de botella y descarga reportes CI/CD." },
                ].map((item) => (
                  <div key={item.step} className="flex flex-col gap-space-sm">
                    <div className="flex items-center gap-space-sm">
                      <span className="w-6 h-6 rounded-lg bg-surface-container-high flex items-center justify-center text-label-code-sm text-on-surface font-mono">
                        {item.step}
                      </span>
                      <span className="material-symbols-outlined text-secondary text-[18px]">
                        {item.icon}
                      </span>
                    </div>
                    <h4 className="text-body-md text-on-surface font-medium">{item.title}</h4>
                    <p className="text-label-code-sm text-on-surface-variant">{item.desc}</p>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </div>
      </div>
    </MainLayout>
  );
}
