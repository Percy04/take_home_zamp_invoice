// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DocumentPreview } from "../frontend_v1/ap-resolve-console/src/components/DocumentPreview";
import type { Run } from "../frontend_v1/ap-resolve-console/src/lib/types";

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
  it("keeps its viewport width fixed while changing PDF zoom", () => {
    render(<DocumentPreview run={run} compact />);
    const viewport = screen.getByTestId("document-viewport");
    const width = viewport.getAttribute("style");

    fireEvent.click(screen.getByRole("button", { name: "+" }));

    expect(viewport).toHaveAttribute("style", width!);
    expect(screen.getByTitle("Original PDF: invoice.pdf")).toHaveAttribute(
      "src",
      expect.stringContaining("zoom=85"),
    );
  });
});
