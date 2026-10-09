"use client";

// k6flow-variables V-T4: environments page (dev/staging/prod variables per user).

import { MainLayout } from "../../lib/layout";
import { EnvironmentsManager } from "../../lib/variables";

export default function EnvironmentsPage() {
  return (
    <MainLayout>
      <div className="px-gutter-desktop py-space-xl flex flex-col gap-space-xl">
        <section className="flex flex-col gap-space-xs">
          <div className="flex items-center gap-space-sm text-label-code-sm text-on-surface-variant uppercase tracking-wider">
            <span className="material-symbols-outlined text-primary text-[16px]">layers</span>
            <span>Variables</span>
          </div>
          <h1 className="text-headline-lg text-on-surface font-semibold tracking-tight">Entornos</h1>
          <p className="text-body-md text-on-surface-variant">
            Define variables por entorno y elige cuál usar al ejecutar desde el editor. Los secretos nunca se muestran
            después de guardarlos.
          </p>
        </section>
        <EnvironmentsManager />
      </div>
    </MainLayout>
  );
}
