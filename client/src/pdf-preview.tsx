import { useEffect, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

export default function PdfPreview({
  url,
  filename,
  page,
  onPageChange,
}: {
  url: string;
  filename: string;
  page: number;
  onPageChange: (page: number) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(560);
  const [pages, setPages] = useState(0);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const update = () =>
      setWidth(
        Math.max(280, Math.min(760, container.current?.clientWidth ?? 560)),
      );
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return (
    <div className="pdf-preview" ref={container}>
      <Document
        file={url}
        loading={<p className="muted">Rendering PDF...</p>}
        onLoadSuccess={({ numPages }) => {
          setPages(numPages);
          setError(undefined);
        }}
        onLoadError={() => setError("The PDF preview could not be rendered.")}
      >
        <Page pageNumber={page} width={width - 24} />
      </Document>
      {error && <p className="error">{error}</p>}
      {pages > 1 && (
        <div className="pdf-controls" aria-label={`${filename} page controls`}>
          <button
            className="secondary"
            disabled={page === 1}
            onClick={() => onPageChange(page - 1)}
          >
            Previous
          </button>
          <span>
            Page {page} of {pages}
          </span>
          <button
            className="secondary"
            disabled={page === pages}
            onClick={() => onPageChange(page + 1)}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
