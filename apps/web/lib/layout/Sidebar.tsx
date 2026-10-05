"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const navItems = [
  { path: "/", label: "Inicio", icon: "grid_view" },
  { path: "/scenarios", label: "Escenarios", icon: "account_tree" },
  { path: "/recordings", label: "Grabaciones", icon: "fiber_manual_record" },
  { path: "/recorder", label: "Grabar", icon: "videocam" },
  { path: "/editor", label: "Editor", icon: "edit_square" },
];

export function Sidebar() {
  const pathname = usePathname();

  const isActive = (path: string) => {
    if (path === "/") return pathname === "/";
    return pathname.startsWith(path);
  };

  return (
    <aside className="fixed left-0 top-0 h-full w-64 bg-surface-container-lowest flex flex-col z-50 shadow-[0_1px_8px_rgba(0,0,0,0.3)]">
      {/* Logo */}
      <div className="h-16 flex items-center justify-between px-space-lg">
        <Link href="/" className="flex items-center gap-space-sm">
          <div className="w-8 h-8 rounded-lg bg-primary-container flex items-center justify-center">
            <span className="text-on-primary-container font-bold text-sm">k6</span>
          </div>
          <div className="flex flex-col">
            <span className="text-headline-sm font-semibold tracking-tight text-on-surface">
              K6Flow
            </span>
            <span className="text-label-code-sm text-secondary">v2.4.0</span>
          </div>
        </Link>
        <button
          type="button"
          className="p-space-xs text-on-surface-variant hover:text-on-surface hover:bg-surface-container rounded-lg transition-colors"
        >
          <span className="material-symbols-outlined text-[18px]">dock_to_right</span>
        </button>
      </div>

      {/* Workspace indicator */}
      <div className="px-space-md py-space-sm">
        <div className="flex items-center justify-between px-space-sm py-space-xs bg-surface-container-low rounded-lg">
          <span className="text-label-code-sm text-on-surface-variant uppercase tracking-wider">
            Workspace
          </span>
          <div className="flex items-center gap-space-xs">
            <span className="w-1.5 h-1.5 rounded-full bg-secondary animate-pulse" />
            <span className="text-body-sm text-on-surface font-medium">Local</span>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-space-md py-space-xs flex flex-col gap-space-xs overflow-y-auto">
        {navItems.map((item) => (
          <Link
            key={item.path}
            href={item.path}
            className={`nav-link ${isActive(item.path) ? "nav-link-active" : ""}`}
          >
            <span className="material-symbols-outlined text-[20px]">{item.icon}</span>
            <span>{item.label}</span>
          </Link>
        ))}
      </nav>

      {/* Footer */}
      <div className="p-space-md flex flex-col gap-space-sm">
        {/* Theme toggle */}
        <div className="flex items-center justify-between px-space-sm py-space-xs bg-surface-container-low rounded-lg">
          <div className="flex items-center gap-space-sm text-on-surface-variant">
            <span className="material-symbols-outlined text-[18px]">dark_mode</span>
            <span className="text-body-sm">Tema oscuro</span>
          </div>
          <div className="w-8 h-4 bg-primary-container rounded-full p-0.5 flex items-center justify-end">
            <span className="w-3 h-3 bg-on-primary-container rounded-full shadow-sm" />
          </div>
        </div>

        {/* User */}
        <div className="flex items-center justify-between p-space-sm rounded-lg bg-surface-container-low hover:bg-surface-container transition-colors">
          <div className="flex items-center gap-space-sm min-w-0">
            <div className="w-8 h-8 rounded-full bg-surface-container-high flex items-center justify-center shrink-0">
              <span className="material-symbols-outlined text-secondary text-[18px]">person</span>
            </div>
            <div className="flex flex-col min-w-0">
              <span className="text-body-sm font-medium text-on-surface truncate">Usuario</span>
              <span className="text-label-code-sm text-on-surface-variant truncate">
                DevOps Engineer
              </span>
            </div>
          </div>
          <button
            type="button"
            className="text-on-surface-variant hover:text-on-surface p-space-xs"
          >
            <span className="material-symbols-outlined text-[18px]">more_vert</span>
          </button>
        </div>
      </div>
    </aside>
  );
}
