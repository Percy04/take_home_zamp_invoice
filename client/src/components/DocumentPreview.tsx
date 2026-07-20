import { useEffect, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import type { Run } from "@/lib/types";
import { documentUrl } from "@/lib/api";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

export function DocumentPreview({ run, compact = false }: { run: Run; compact?: boolean }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(100);
  const [pages, setPages] = useState(0);
  const [width, setWidth] = useState(560);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const update = () => setWidth(Math.max(280, (viewport.current?.clientWidth ?? 584) - 24));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    // The document identity changed, so its local viewer state must restart.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPage(1);
    setPages(0);
    setFailed(false);
  }, [run.runId]);

  const pageWidth = Math.round((width * zoom) / 100);

  return (
    <section className="panel flex flex-col">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div>
          <p className="eyebrow">Source document</p>
          <div className="mt-0.5 text-[13px] font-medium text-foreground">{run.filename}</div>
        </div>
        <div className="flex items-center gap-1 text-[12px]">
          <button
            aria-label="Previous page"
            onClick={() => setPage(Math.max(1, page - 1))}
            disabled={page === 1}
            className="rounded border border-border px-2 py-1 disabled:opacity-50"
          >
            ‹
          </button>
          <span className="tabular text-muted-foreground">
            Page {page} of {pages || "—"}
          </span>
          <button
            aria-label="Next page"
            onClick={() => setPage(Math.min(pages || 1, page + 1))}
            disabled={!pages || page === pages}
            className="rounded border border-border px-2 py-1 disabled:opacity-50"
          >
            ›
          </button>
          <div className="mx-2 h-4 w-px bg-border" />
          <button aria-label="Zoom out" onClick={() => setZoom(Math.max(50, zoom - 25))} className="rounded border border-border px-2 py-1">
            −
          </button>
          <span className="tabular text-muted-foreground">{zoom}%</span>
          <button aria-label="Zoom in" onClick={() => setZoom(Math.min(200, zoom + 25))} className="rounded border border-border px-2 py-1">
            +
          </button>
        </div>
      </header>
      <div ref={viewport} className={compact ? "bg-surface-muted p-3" : "bg-surface-muted p-4"}>
        {failed ? (
          <div className="rounded-md border border-destructive/25 bg-destructive-soft/30 p-4 text-[13px] text-destructive">
            The document preview could not be loaded.{" "}
            <button onClick={() => setFailed(false)} className="underline">
              Try again
            </button>
            .
          </div>
        ) : (
          <div data-testid="document-viewport" className="max-h-[560px] overflow-auto rounded border border-border bg-surface shadow-sm">
            <Document
              key={run.runId}
              file={documentUrl(run.runId)}
              loading={<p className="p-3 text-[13px] text-muted-foreground">Rendering PDF…</p>}
              onLoadSuccess={({ numPages }) => {
                setPages(numPages);
                setPage((current) => Math.min(current, numPages));
              }}
              onLoadError={() => setFailed(true)}
            >
              <Page pageNumber={page} width={pageWidth} />
            </Document>
          </div>
        )}
      </div>
    </section>
  );
}
