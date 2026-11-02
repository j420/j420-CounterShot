import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CounterShot — Make the job fit",
  description:
    "Observe a physical job. Design the package, workspace and steps around the person doing it.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
