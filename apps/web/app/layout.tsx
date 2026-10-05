import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "K6Flow",
  description: "Visual load testing platform for k6",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es" className="dark">
      <body className="bg-background text-on-surface font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
