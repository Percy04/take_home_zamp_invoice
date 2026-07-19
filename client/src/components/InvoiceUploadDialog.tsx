import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import * as api from "@/lib/api";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const MAX_FILE_SIZE = 10 * 1024 * 1024;

export function InvoiceUploadDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);

  function chooseFile(next: File | null) {
    setError(null);
    if (!next) return setFile(null);
    if (next.type !== "application/pdf" && !next.name.toLowerCase().endsWith(".pdf")) {
      setFile(null);
      return setError("Only PDF files are accepted.");
    }
    if (next.size > MAX_FILE_SIZE) {
      setFile(null);
      return setError("File is too large. Maximum size is 10 MiB.");
    }
    setFile(next);
  }

  async function submit() {
    if (!file) return setError("Choose a PDF to upload.");
    setBusy(true);
    setError(null);
    try {
      const run = await api.createRun(file);
      onOpenChange(false);
      await navigate({ to: "/runs/$runId", params: { runId: run.runId } });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The invoice could not be uploaded.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-5 py-4 pr-12">
          <DialogTitle className="font-serif text-xl">Upload an invoice</DialogTitle>
          <DialogDescription>Add a PDF to extract, match and run through accounting controls.</DialogDescription>
        </DialogHeader>

        <div className="p-5">
          <section
            aria-label="Invoice document"
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              chooseFile(event.dataTransfer.files?.[0] ?? null);
            }}
            className={`rounded-md border border-dashed px-5 py-8 text-center transition-colors ${dragging ? "border-primary bg-primary-soft" : "border-border bg-surface-muted/50"}`}
          >
            <div aria-hidden className="mx-auto grid h-10 w-10 place-items-center rounded-full bg-primary-soft text-primary">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 3v12" />
                <path d="m7 8 5-5 5 5" />
                <path d="M4 17v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
              </svg>
            </div>
            <p className="mt-3 text-[13px] font-medium">Drop a PDF here or choose a file</p>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="mt-3 rounded-md border border-border bg-surface px-3 py-1.5 text-[13px] font-medium hover:bg-muted"
            >
              Choose file
            </button>
            <input
              ref={inputRef}
              aria-label="Invoice PDF"
              type="file"
              accept="application/pdf,.pdf"
              className="sr-only"
              onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
            />
            <p className="mt-2 text-[11.5px] text-muted-foreground">PDF only · Max 10 MiB</p>
          </section>

          {file && (
            <div className="mt-3 flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-[13px] font-medium">{file.name}</div>
                <div className="font-mono text-[11px] text-muted-foreground">{(file.size / 1024).toFixed(0)} KB</div>
              </div>
              <button
                type="button"
                onClick={() => {
                  chooseFile(null);
                  if (inputRef.current) inputRef.current.value = "";
                }}
                className="text-[12px] text-muted-foreground hover:text-foreground"
              >
                Remove
              </button>
            </div>
          )}

          {error && (
            <p role="alert" className="mt-3 text-[12.5px] text-destructive">
              {error}
            </p>
          )}

          <div className="mt-5 flex justify-end gap-2 border-t border-border pt-4">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              disabled={busy}
              className="rounded-md border border-border px-3 py-2 text-[13px] font-medium hover:bg-muted disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={busy || !file}
              className="rounded-md bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Uploading…" : "Upload and process"}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
