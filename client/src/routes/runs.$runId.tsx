import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import * as api from "@/lib/api";
import { useStore } from "@/lib/store";
import type { Run } from "@/lib/types";
import { CompactRunWorkspace } from "@/components/CompactRunWorkspace";
import { RunDetailTabs } from "@/components/RunDetailTabs";
import { ProcessingProgress } from "@/components/ProcessingProgress";

export const Route = createFileRoute("/runs/$runId")({
  head: () => ({
    meta: [
      { title: "Invoice run — AP Resolution" },
      { name: "description", content: "Review the outcome and evidence for a single invoice." },
    ],
  }),
  component: RunPage,
});

function RunPage() {
  const { runId } = Route.useParams();
  const navigate = useNavigate();
  const run = useStore((s) => s.runs.find((r) => r.runId === runId));
  const [statusError, setStatusError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getRun(runId)
      .then(async (result) => {
        if (cancelled) return;
        if (!result) setStatusError(true);
      })
      .catch(() => setStatusError(true));
    return () => {
      cancelled = true;
    };
  }, [runId]);

  useEffect(() => {
    if (run?.state !== "PROCESSING") return;
    const poll = () => void api.getRun(runId).then((result) => !result && setStatusError(true));
    const timer = window.setInterval(poll, 500);
    return () => window.clearInterval(timer);
  }, [run?.state, runId]);

  if (!run) {
    return (
      <div className="panel p-6 text-center">
        {statusError ? (
          <>
            <p className="eyebrow">Status unavailable</p>
            <h1 className="mt-1 text-lg font-semibold">Processing status is unavailable</h1>
            <p className="mt-1 text-[13px] text-muted-foreground">The server may still be processing this invoice.</p>
            <div className="mt-4 flex justify-center gap-2">
              <button
                onClick={() => setStatusError(false)}
                className="rounded-md bg-primary px-3 py-1.5 text-[12.5px] font-semibold text-primary-foreground"
              >
                Refresh status
              </button>
              <button
                onClick={() => navigate({ to: "/dashboard" })}
                className="rounded-md border border-border bg-surface px-3 py-1.5 text-[12.5px] font-medium"
              >
                Back to invoices
              </button>
            </div>
          </>
        ) : (
          <p className="text-[13px] text-muted-foreground">Loading run…</p>
        )}
      </div>
    );
  }

  return <RunView run={run} />;
}

function RunView({ run }: { run: Run }) {
  const isProcessing = run.state === "PROCESSING";

  return (
    <CompactRunWorkspace run={run}>
      {isProcessing && <ProcessingProgress run={run} />}
      <RunDetailTabs run={run} />
    </CompactRunWorkspace>
  );
}
