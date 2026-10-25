"use client";

/** Title block of the HAR import screen; static copy only, no state. */
export function HarImportHeader() {
  return (
    <section className="flex flex-col gap-space-xs">
      <div className="flex items-center gap-space-sm text-label-code-sm text-on-surface-variant uppercase tracking-wider">
        <span className="material-symbols-outlined text-secondary text-[16px]" aria-hidden="true">upload_file</span>
        <span>Importar tráfico</span>
      </div>
      <h1 className="text-headline-lg text-on-surface font-semibold tracking-tight">
        Importar HAR
      </h1>
      <p className="text-body-md text-on-surface-variant">
        Sube un archivo <span className="font-mono">.har</span> exportado del navegador, filtra
        las peticiones como en las DevTools y guarda solo las que necesites en el escenario.
      </p>
    </section>
  );
}
