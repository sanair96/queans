import type { Metadata } from "next";
import Link from "next/link";
import { Archive, ClipboardCheck, FileUp, ListChecks } from "lucide-react";

import "./globals.css";

export const metadata: Metadata = {
  title: "Queans",
  description: "Question paper ingestion and review"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <aside className="sidebar">
            <div className="brand">
              <span className="brand-mark">Q</span>
              <span>Queans</span>
            </div>
            <nav className="nav" aria-label="Primary navigation">
              <Link href="/">
                <FileUp size={18} aria-hidden="true" />
                Upload
              </Link>
              <Link href="/review">
                <ClipboardCheck size={18} aria-hidden="true" />
                Review
              </Link>
              <Link href="/questions">
                <Archive size={18} aria-hidden="true" />
                Questions
              </Link>
              <Link href="/runs">
                <ListChecks size={18} aria-hidden="true" />
                Runs
              </Link>
            </nav>
          </aside>
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}

