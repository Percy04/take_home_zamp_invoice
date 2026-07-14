import type { RunState } from "@/lib/types";

const LABEL: Record<RunState, string> = {
  PROCESSING: "Processing",
  POSTED: "Posted",
  AWAITING_PO_CONFIRMATION: "Awaiting PO",
  AWAITING_BUNDLE_CONFIRMATION: "Awaiting bundle",
  NEEDS_REVIEW: "Needs review",
};

export function StatusBadge({ state, size = "md" }: { state: RunState; size?: "sm" | "md" }) {
  const styles: Record<RunState, string> = {
    PROCESSING: "bg-info-soft text-info border-info/20",
    POSTED: "bg-success-soft text-success border-success/20",
    AWAITING_PO_CONFIRMATION: "bg-warning-soft text-warning border-warning/25",
    AWAITING_BUNDLE_CONFIRMATION: "bg-warning-soft text-warning border-warning/25",
    NEEDS_REVIEW: "bg-destructive-soft text-destructive border-destructive/20",
  };
  const sz = size === "sm" ? "px-1.5 py-0.5 text-[10.5px]" : "px-2 py-0.5 text-[11.5px]";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded border font-medium ${sz} ${styles[state]}`}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
      {LABEL[state]}
    </span>
  );
}
