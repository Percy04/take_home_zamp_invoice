import type { Run } from "@/lib/types";

export function ProcessingProgress({ run }: { run: Run }) {
  return (
    <section className="panel p-4" aria-live="polite">
      <p className="eyebrow mb-3">Processing</p>
      <ol className="space-y-2">
        {run.stages.map((s) => (
          <li key={s.stage} className="flex items-start gap-3">
            <span
              className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-bold ${
                s.status === "DONE"
                  ? "bg-success-soft text-success"
                  : s.status === "IN_PROGRESS"
                    ? "bg-info-soft text-info"
                    : s.status === "FAILED"
                      ? "bg-destructive-soft text-destructive"
                      : "bg-muted text-muted-foreground"
              }`}
            >
              {s.status === "DONE" ? "✓" : s.status === "FAILED" ? "!" : s.status === "IN_PROGRESS" ? "•" : "◦"}
            </span>
            <div className="flex-1">
              <div className="flex items-baseline justify-between">
                <div className="text-[13px] font-medium">{s.label}</div>
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  {s.status === "IN_PROGRESS" ? "In progress" : s.status === "DONE" ? "Done" : s.status === "FAILED" ? "Failed" : "Pending"}
                </div>
              </div>
              {s.detail && <div className="text-[12.5px] text-muted-foreground">{s.detail}</div>}
              {s.status === "IN_PROGRESS" && (
                <div className="mt-1.5 h-1 w-full overflow-hidden rounded bg-muted">
                  <div className="h-full w-1/2 animate-pulse bg-info/60" />
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
