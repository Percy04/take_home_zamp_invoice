// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRouter } from "../client/src/router";

vi.mock("react-pdf", () => ({
  pdfjs: { GlobalWorkerOptions: {} },
  Document: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  Page: () => <div>PDF page</div>,
}));

describe("main Lovable frontend", () => {
  afterEach(() => vi.unstubAllGlobals());

  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            items: [],
            nextCursor: null,
            metrics: {
              totalRuns: 0,
              postedCount: 0,
              reviewCount: 0,
              autoClearRate: "0.0",
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
  });

  it("uses one dashboard with an invoice upload modal", async () => {
    render(<RouterProvider router={getRouter()} />);

    expect(
      await screen.findByRole("heading", { name: "Recent invoice runs" }),
    ).toBeVisible();
    expect(screen.queryByText("Intake")).not.toBeInTheDocument();
    expect(screen.queryByText("Activity")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add invoice" }));
    expect(
      screen.getByRole("dialog", { name: "Upload an invoice" }),
    ).toBeVisible();
  });
});
