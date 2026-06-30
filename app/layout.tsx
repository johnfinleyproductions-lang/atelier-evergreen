import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Atelier",
  description: "Atelier — the proof-gated studio floor.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
