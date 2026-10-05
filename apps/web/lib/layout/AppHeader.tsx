"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

interface User {
  username: string;
  role: string;
}

export function AppHeader() {
  const pathname = usePathname();
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setUser(data))
      .catch(() => setUser(null));
  }, []);

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setUser(null);
    window.location.href = "/";
  };

  const isActive = (path: string) => pathname === path || pathname?.startsWith(path + "/");

  const navLinkClass = (path: string) =>
    `${isActive(path) ? "text-white" : "text-gray-400"} hover:text-white transition-colors`;

  return (
    <header className="border-b border-gray-800 bg-gray-900/95 backdrop-blur sticky top-0 z-50">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
        <div className="flex items-center gap-8">
          <Link href="/" className="text-xl font-bold text-white">
            K6Flow
          </Link>
          {user && (
            <nav className="hidden md:flex items-center gap-6">
              <Link href="/scenarios" className={navLinkClass("/scenarios")}>
                Scenarios
              </Link>
              <Link href="/recordings" className={navLinkClass("/recordings")}>
                Recordings
              </Link>
              <Link href="/editor" className={navLinkClass("/editor")}>
                Editor
              </Link>
              <Link href="/recorder" className={navLinkClass("/recorder")}>
                Recorder
              </Link>
            </nav>
          )}
        </div>

        <div className="flex items-center gap-4">
          {user ? (
            <>
              <span className="text-sm text-gray-400">{user.username}</span>
              <button
                onClick={handleLogout}
                className="text-sm text-gray-400 hover:text-white"
              >
                Logout
              </button>
            </>
          ) : (
            <Link
              href="/login"
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-500"
            >
              Sign in
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
