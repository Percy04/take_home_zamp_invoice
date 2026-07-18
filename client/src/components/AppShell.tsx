import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useState } from "react";
import { resetWorkspace } from "@/lib/api";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border bg-surface/95 backdrop-blur">
        <div className="mx-auto w-full max-w-[1600px] px-4 py-2.5 md:px-6 xl:px-8">
          <div className="mx-auto flex min-h-9 max-w-[1500px] items-center gap-4">
            <BrandMark />
            <div className="ml-auto">
              <ResetButton compact />
            </div>
          </div>
        </div>
      </header>
      <main className="min-w-0">
        <div className="mx-auto w-full max-w-[1600px] px-4 py-5 md:px-6 md:py-6 xl:px-8">{children}</div>
      </main>
    </div>
  );
}

function BrandMark() {
  return (
    <Link
      to="/dashboard"
      aria-label="AP Resolution dashboard"
      className="flex items-center gap-2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div aria-hidden className="grid h-7 w-7 place-items-center rounded-md bg-primary text-primary-foreground">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 6h16M4 12h10M4 18h16" />
        </svg>
      </div>
      <div className="leading-tight">
        <div className="text-[13px] font-semibold tracking-tight">AP Resolution</div>
        <div className="text-[10.5px] uppercase tracking-wider text-muted-foreground">Invoice review</div>
      </div>
    </Link>
  );
}

function ResetButton({ compact = false }: { compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={async () => {
        setBusy(true);
        await resetWorkspace();
        setBusy(false);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
      disabled={busy}
      className={`${compact ? "rounded-md px-2 py-1.5 text-[11px]" : "w-full px-2.5 py-1.5 text-left text-[12px]"} border border-border bg-surface text-muted-foreground hover:bg-muted disabled:opacity-60`}
    >
      <div className="flex items-center justify-between">
        <span>Reset workspace</span>
        {done ? <span className="text-success">Done</span> : busy ? <span>…</span> : <span className="opacity-60">Ready</span>}
      </div>
      {!compact && (
        <div className="mt-0.5 text-[11px] leading-snug opacity-70">Clear invoice history and restore the starting workspace.</div>
      )}
    </button>
  );
}
