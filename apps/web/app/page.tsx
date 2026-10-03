"use client";

// K6F4-02c fix: Updated home page with navigation.

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function Home() {
  const router = useRouter();
  const [runId, setRunId] = useState("");
  const [user, setUser] = useState<{ username: string } | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(true);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setUser(data))
      .catch(() => setUser(null))
      .finally(() => setCheckingAuth(false));
  }, []);

  function openMetrics(event: React.FormEvent) {
    event.preventDefault();
    const id = runId.trim();
    if (id) router.push(`/runs/${encodeURIComponent(id)}`);
  }

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    setUser(null);
  }

  return (
    <main style={containerStyle}>
      {/* Header */}
      <header style={headerStyle}>
        <h1 style={logoStyle}>K6Flow</h1>
        <nav style={navStyle}>
          {checkingAuth ? null : user ? (
            <>
              <span style={userStyle}>👤 {user.username}</span>
              <Link href="/editor" style={linkStyle}>Editor</Link>
              <Link href="/recorder" style={linkStyle}>Recorder</Link>
              <button onClick={handleLogout} style={logoutStyle}>Logout</button>
            </>
          ) : (
            <Link href="/login" style={primaryLinkStyle}>Sign in</Link>
          )}
        </nav>
      </header>

      {/* Hero */}
      <section style={heroStyle}>
        <h2 style={heroTitleStyle}>Visual Load Testing</h2>
        <p style={heroSubtitleStyle}>
          Design, execute, and monitor K6 load tests with a visual editor.
        </p>
        {user ? (
          <Link href="/editor" style={ctaButtonStyle}>Open Editor</Link>
        ) : (
          <Link href="/login" style={ctaButtonStyle}>Get Started</Link>
        )}
      </section>

      {/* Live Metrics */}
      <section style={sectionStyle}>
        <h3 style={sectionTitleStyle}>Live Metrics</h3>
        <p style={sectionTextStyle}>
          Open the live dashboard for a running test by ID:
        </p>
        <form onSubmit={openMetrics} style={formStyle}>
          <input
            value={runId}
            onChange={(e) => setRunId(e.target.value)}
            placeholder="Run ID"
            aria-label="Run ID"
            style={inputStyle}
          />
          <button type="submit" style={buttonStyle}>Open Dashboard</button>
        </form>
      </section>
    </main>
  );
}

const containerStyle: React.CSSProperties = {
  minHeight: "100vh",
  fontFamily: "system-ui, sans-serif",
  background: "#f9fafb",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "16px 24px",
  background: "#fff",
  borderBottom: "1px solid #e5e7eb",
};

const logoStyle: React.CSSProperties = {
  fontSize: "20px",
  fontWeight: 700,
  color: "#111827",
  margin: 0,
};

const navStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "16px",
};

const userStyle: React.CSSProperties = {
  fontSize: "14px",
  color: "#6b7280",
};

const linkStyle: React.CSSProperties = {
  fontSize: "14px",
  color: "#2563eb",
  textDecoration: "none",
  fontWeight: 500,
};

const primaryLinkStyle: React.CSSProperties = {
  ...linkStyle,
  padding: "8px 16px",
  background: "#2563eb",
  color: "#fff",
  borderRadius: "6px",
};

const logoutStyle: React.CSSProperties = {
  fontSize: "14px",
  color: "#6b7280",
  background: "none",
  border: "none",
  cursor: "pointer",
};

const heroStyle: React.CSSProperties = {
  textAlign: "center",
  padding: "80px 24px",
  background: "#fff",
};

const heroTitleStyle: React.CSSProperties = {
  fontSize: "48px",
  fontWeight: 700,
  color: "#111827",
  margin: "0 0 16px",
};

const heroSubtitleStyle: React.CSSProperties = {
  fontSize: "18px",
  color: "#6b7280",
  margin: "0 0 32px",
};

const ctaButtonStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "14px 28px",
  fontSize: "16px",
  fontWeight: 600,
  color: "#fff",
  background: "#2563eb",
  borderRadius: "8px",
  textDecoration: "none",
};

const sectionStyle: React.CSSProperties = {
  maxWidth: "600px",
  margin: "0 auto",
  padding: "48px 24px",
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: "24px",
  fontWeight: 600,
  color: "#111827",
  margin: "0 0 12px",
};

const sectionTextStyle: React.CSSProperties = {
  fontSize: "14px",
  color: "#6b7280",
  margin: "0 0 16px",
};

const formStyle: React.CSSProperties = {
  display: "flex",
  gap: "8px",
};

const inputStyle: React.CSSProperties = {
  flex: 1,
  padding: "10px 12px",
  fontSize: "14px",
  border: "1px solid #d1d5db",
  borderRadius: "6px",
};

const buttonStyle: React.CSSProperties = {
  padding: "10px 20px",
  fontSize: "14px",
  fontWeight: 500,
  color: "#fff",
  background: "#2563eb",
  border: "none",
  borderRadius: "6px",
  cursor: "pointer",
};
