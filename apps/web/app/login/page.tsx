"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      if (res.ok) {
        router.push("/");
      } else {
        const data = await res.json();
        setError(data.error || "Error de autenticación");
      }
    } catch {
      setError("Error de red");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-background text-on-surface">
      {/* Ambient glow */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-primary-container/5 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 right-1/4 w-80 h-80 bg-secondary/5 rounded-full blur-3xl" />
      </div>

      {/* Header */}
      <header className="relative z-10 border-b border-surface-container">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-gutter-desktop py-space-lg">
          <Link href="/" className="flex items-center gap-space-sm">
            <div className="w-8 h-8 rounded-lg bg-primary-container flex items-center justify-center">
              <span className="text-on-primary-container font-bold text-sm">k6</span>
            </div>
            <span className="text-headline-sm font-semibold text-on-surface">K6Flow</span>
          </Link>
        </div>
      </header>

      {/* Main content */}
      <main className="relative z-10 flex flex-1 items-center justify-center px-gutter-desktop py-space-xl">
        <div className="w-full max-w-md">
          <div className="card">
            <div className="text-center mb-space-xl">
              <div className="w-16 h-16 rounded-xl bg-primary-container/20 flex items-center justify-center mx-auto mb-space-lg">
                <span className="material-symbols-outlined text-primary text-[32px]">login</span>
              </div>
              <h1 className="text-headline-lg text-on-surface font-semibold mb-space-xs">
                Bienvenido
              </h1>
              <p className="text-body-md text-on-surface-variant">
                Inicia sesión para acceder a tus escenarios y grabaciones
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-space-lg">
              {error && (
                <div className="p-space-md rounded-lg bg-error/10 border border-error/30 text-error text-body-sm">
                  <span className="material-symbols-outlined text-[16px] mr-space-xs align-middle">error</span>
                  {error}
                </div>
              )}

              <div>
                <label htmlFor="username" className="block text-body-sm text-on-surface-variant mb-space-sm">
                  Usuario
                </label>
                <input
                  id="username"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="input"
                  required
                  autoFocus
                  autoComplete="username"
                  placeholder="tu.usuario"
                />
              </div>

              <div>
                <label htmlFor="password" className="block text-body-sm text-on-surface-variant mb-space-sm">
                  Contraseña
                </label>
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="input"
                  required
                  autoComplete="current-password"
                  placeholder="••••••••"
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="btn-primary w-full justify-center py-space-md"
              >
                {loading ? (
                  <>
                    <div className="animate-spin w-4 h-4 border-2 border-on-primary-container border-t-transparent rounded-full" />
                    <span>Iniciando sesión...</span>
                  </>
                ) : (
                  <>
                    <span className="material-symbols-outlined text-[18px]">login</span>
                    <span>Iniciar Sesión</span>
                  </>
                )}
              </button>
            </form>

            <div className="mt-space-lg pt-space-lg border-t border-surface-container text-center">
              <p className="text-body-sm text-on-surface-variant">
                ¿Primera vez aquí?{" "}
                <Link href="/" className="text-primary hover:text-secondary transition-colors">
                  Continuar como invitado
                </Link>
              </p>
            </div>
          </div>

          {/* Features reminder */}
          <div className="mt-space-lg grid grid-cols-3 gap-space-md text-center">
            {[
              { icon: "videocam", label: "Grabar sesiones" },
              { icon: "account_tree", label: "Diseñar escenarios" },
              { icon: "speed", label: "Ejecutar pruebas" },
            ].map((item) => (
              <div key={item.icon} className="flex flex-col items-center gap-space-xs">
                <span className="material-symbols-outlined text-on-surface-variant text-[24px]">
                  {item.icon}
                </span>
                <span className="text-label-code-sm text-on-surface-variant">{item.label}</span>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
