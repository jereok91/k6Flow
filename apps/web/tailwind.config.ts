// NOT LOADED: Tailwind CSS v4 does not read this file (globals.css has no
// `@config`, intentionally). The design tokens are defined in the `@theme`
// block of app/globals.css, and the runtime light/dark values live in its
// `:root, .dark` and `.light` blocks. Edit tokens there; this file is kept
// only as a reference and may be removed.
import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Surface colors
        surface: "#10141a",
        "surface-dim": "#10141a",
        "surface-bright": "#353940",
        "surface-container-lowest": "#0a0e14",
        "surface-container-low": "#181c22",
        "surface-container": "#1c2026",
        "surface-container-high": "#262a31",
        "surface-container-highest": "#31353c",
        
        // On-surface
        "on-surface": "#dfe2eb",
        "on-surface-variant": "#ccc3d8",
        "inverse-surface": "#dfe2eb",
        "inverse-on-surface": "#2d3137",
        
        // Outline
        outline: "#958da1",
        "outline-variant": "#4a4455",
        "surface-tint": "#d2bbff",
        
        // Primary - Purple
        primary: "#d2bbff",
        "on-primary": "#3f008e",
        "primary-container": "#7c3aed",
        "on-primary-container": "#ede0ff",
        "inverse-primary": "#732ee4",
        
        // Secondary - Cyan
        secondary: "#4cd7f6",
        "on-secondary": "#003640",
        "secondary-container": "#03b5d3",
        "on-secondary-container": "#00424e",
        
        // Tertiary
        tertiary: "#d0bcff",
        "on-tertiary": "#3c0091",
        "tertiary-container": "#7645e0",
        "on-tertiary-container": "#ece1ff",
        
        // Error
        error: "#ffb4ab",
        "on-error": "#690005",
        "error-container": "#93000a",
        "on-error-container": "#ffdad6",
        
        // Fixed colors
        "primary-fixed": "#eaddff",
        "primary-fixed-dim": "#d2bbff",
        "on-primary-fixed": "#25005a",
        "on-primary-fixed-variant": "#5a00c6",
        "secondary-fixed": "#acedff",
        "secondary-fixed-dim": "#4cd7f6",
        "on-secondary-fixed": "#001f26",
        "on-secondary-fixed-variant": "#004e5c",
        "tertiary-fixed": "#e9ddff",
        "tertiary-fixed-dim": "#d0bcff",
        "on-tertiary-fixed": "#23005c",
        "on-tertiary-fixed-variant": "#5516be",
        
        // Background
        background: "#10141a",
        "on-background": "#dfe2eb",
        "surface-variant": "#31353c",
      },
      borderRadius: {
        DEFAULT: "0.25rem",
        lg: "0.5rem",
        xl: "0.75rem",
        full: "9999px",
      },
      spacing: {
        "space-xs": "0.25rem",
        "space-sm": "0.5rem",
        "space-md": "0.75rem",
        "space-lg": "1rem",
        "space-xl": "1.5rem",
        gutter: "1rem",
        "gutter-desktop": "1.25rem",
        margin: "1rem",
        "margin-tablet": "1.5rem",
        "margin-desktop": "2rem",
      },
      fontFamily: {
        sans: ["Geist", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
      },
      fontSize: {
        "label-code-sm": ["11px", { lineHeight: "16px", letterSpacing: "0.02em", fontWeight: "400" }],
        "label-code-md": ["12px", { lineHeight: "18px", letterSpacing: "0em", fontWeight: "400" }],
        "label-code-lg": ["13px", { lineHeight: "20px", letterSpacing: "-0.01em", fontWeight: "500" }],
        "body-sm": ["12px", { lineHeight: "18px", letterSpacing: "0.01em", fontWeight: "400" }],
        "body-md": ["13px", { lineHeight: "20px", letterSpacing: "0em", fontWeight: "400" }],
        "body-lg": ["15px", { lineHeight: "24px", letterSpacing: "-0.005em", fontWeight: "400" }],
        "headline-sm": ["16px", { lineHeight: "24px", letterSpacing: "-0.01em", fontWeight: "500" }],
        "headline-md": ["20px", { lineHeight: "28px", letterSpacing: "-0.015em", fontWeight: "500" }],
        "headline-lg": ["24px", { lineHeight: "32px", letterSpacing: "-0.02em", fontWeight: "600" }],
        display: ["36px", { lineHeight: "44px", letterSpacing: "-0.03em", fontWeight: "600" }],
        "display-mobile": ["28px", { lineHeight: "36px", letterSpacing: "-0.02em", fontWeight: "600" }],
        "metric-huge": ["32px", { lineHeight: "40px", letterSpacing: "-0.03em", fontWeight: "600" }],
      },
      boxShadow: {
        glow: "0 0 12px rgba(124, 58, 237, 0.35)",
        "glow-secondary": "0 0 12px rgba(76, 215, 246, 0.35)",
        modal: "0 12px 32px rgba(0, 0, 0, 0.6)",
      },
    },
  },
  plugins: [],
};

export default config;
