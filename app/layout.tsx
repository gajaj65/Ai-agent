import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Threeway — Shared AI Chat Room",
  description: "One shared chat room for You, ChatGPT and Muse.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
