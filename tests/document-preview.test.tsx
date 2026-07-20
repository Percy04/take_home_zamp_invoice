// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DocumentPreview } from "../client/src/components/DocumentPreview";
import type { Run } from "../client/src/lib/types";

vi.mock("react-pdf", () => ({
  pdfjs: { GlobalWorkerOptions: {} },
  Document: ({ children, onLoadSuccess }: { children: React.ReactNode; onLoadSuccess: (document: { numPages: number }) => void }) => (
    <div>
      <button onClick={() => onLoadSuccess({ numPages: 2 })}>Load PDF</button>
      {children}
    </div>
  ),
  Page: ({ pageNumber, width }: { pageNumber: number; width: number }) => (
    <div data-testid="pdf-page" data-width={width}>
      Page {pageNumber}
    </div>
  ),
}));

const run = {
  runId: "11111111-1111-4111-8111-111111111111",
  filename: "invoice.pdf",
  state: "POSTED",
  execution: "POSTED",
  reasonCode: "APPROVED_DIRECT",
  nextAction: null,
  ledgerId: "LEDGER-1",
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T00:00:00.000Z",
  stages: [],
  invoice: null,
  checks: [],
  activity: [],
} satisfies Run;

describe("DocumentPreview", () => {
  it("uses real page counts and fit-width zoom controls", () => {
    render(<DocumentPreview run={run} compact />);

    expect(screen.getByTestId("document-viewport")).toHaveClass("max-h-[560px]", "overflow-auto");
    expect(screen.getByTestId("document-viewport").closest("section")).not.toHaveClass("xl:h-full");
    expect(screen.getByText("Page 1 of —")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Load PDF" }));
    expect(screen.getByText("Page 1 of 2")).toBeVisible();
    const page = screen.getByTestId("pdf-page");
    const initialWidth = page.dataset.width;

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByText("125%")).toBeVisible();
    expect(page.dataset.width).not.toBe(initialWidth);

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByText("Page 2")).toBeVisible();
  });
});
