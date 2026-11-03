import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "CounterShot — See, act, check", description: "Use your camera to work through complex physical routing, reconstruction, threading, seating and flow tasks with frame-linked guidance and operator verification." };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }
