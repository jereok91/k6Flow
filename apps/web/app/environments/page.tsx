"use client";

// k6flow-variables V-T4: environments page (dev/staging/prod variables per user).
// Styling follows app/executions/page.tsx: inline styles over the theme CSS variables
// defined in app/globals.css.

import { MainLayout } from "../../lib/layout";
import { EnvironmentsManager } from "../../lib/variables";

export default function EnvironmentsPage() {
  return (
    <MainLayout>
      <div style={containerStyle}>
        <header style={headerStyle}>
          <div style={eyebrowStyle}>
            <span className="material-symbols-outlined" style={{ fontSize: 16, color: "var(--color-primary)" }}>
              layers
            </span>
            <span>Variables</span>
          </div>
          <h1 style={titleStyle}>Entornos</h1>
          <p style={subtitleStyle}>
            Define variables por entorno y elige cuál usar al ejecutar desde el editor. Los secretos nunca se muestran
            después de guardarlos.
          </p>
        </header>
        <EnvironmentsManager />
      </div>
    </MainLayout>
  );
}

const containerStyle: React.CSSProperties = {
  padding: "24px",
  maxWidth: "1200px",
  margin: "0 auto",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "4px",
  marginBottom: "24px",
};

const eyebrowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  fontFamily: "var(--font-mono)",
  fontSize: "11px",
  lineHeight: "16px",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--color-on-surface-variant)",
};

const titleStyle: React.CSSProperties = {
  fontSize: "24px",
  lineHeight: "32px",
  fontWeight: 600,
  letterSpacing: "-0.02em",
  margin: 0,
  color: "var(--color-on-surface)",
};

const subtitleStyle: React.CSSProperties = {
  fontSize: "14px",
  lineHeight: "20px",
  color: "var(--color-on-surface-variant)",
  margin: 0,
  maxWidth: "720px",
};
