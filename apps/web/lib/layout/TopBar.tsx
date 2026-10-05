"use client";

import Link from "next/link";

export function TopBar() {
  return (
    <header className="fixed top-0 left-64 right-0 h-16 bg-surface-container-lowest/80 backdrop-blur-xl z-40 shadow-[0_1px_8px_rgba(0,0,0,0.3)] flex items-center justify-between px-gutter-desktop">
      {/* Breadcrumb */}
      <div className="flex items-center gap-space-xs text-body-sm text-on-surface-variant">
        <span className="text-label-code-sm">k6</span>
        <span className="material-symbols-outlined text-[14px]">chevron_right</span>
        <span className="text-on-surface font-medium">Plataforma</span>
      </div>

      {/* Search */}
      <div className="flex-1 max-w-md mx-space-xl">
        <div className="relative flex items-center">
          <span className="material-symbols-outlined absolute left-space-md text-[18px] text-on-surface-variant">
            search
          </span>
          <input
            type="text"
            className="w-full h-9 pl-9 pr-12 bg-surface-container-low rounded-lg text-body-sm text-on-surface placeholder:text-on-surface-variant focus:outline-none focus:bg-surface-container transition-colors"
            placeholder="Buscar escenarios, pruebas, registros..."
          />
          <div className="absolute right-space-sm px-1.5 py-0.5 rounded-lg bg-surface-container-high text-on-surface-variant text-label-code-sm">
            /
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-space-md">
        <Link href="/recorder" className="btn-primary">
          <span className="material-symbols-outlined text-[18px]">add</span>
          <span>Nueva prueba</span>
        </Link>

        <button
          type="button"
          className="relative p-space-sm text-on-surface-variant hover:text-on-surface hover:bg-surface-container rounded-lg transition-colors"
        >
          <span className="material-symbols-outlined text-[20px]">notifications</span>
        </button>

        <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center">
          <span className="material-symbols-outlined text-on-primary text-[18px]">person</span>
        </div>
      </div>
    </header>
  );
}
