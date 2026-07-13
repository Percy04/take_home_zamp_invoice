// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { RouterProvider } from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getRouter } from "../frontend_v1/ap-resolve-console/src/router";
import * as store from "../frontend_v1/ap-resolve-console/src/lib/store";

vi.mock("react-pdf", () => ({
  pdfjs: { GlobalWorkerOptions: {} },
  Document: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  Page: () => <div>PDF page</div>,
}));

afterEach(() => {
  cleanup();
  store.clearRuns();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("active activity layout", () => {
  it("shows an empty workspace with an add-invoice action after reset", async () => {
    window.history.replaceState({}, "", "/dashboard");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            items: [],
            nextCursor: null,
            metrics: { totalRuns: 0, postedCount: 0, reviewCount: 0, autoClearRate: "0.0" },
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    render(<RouterProvider router={getRouter()} />);

    expect(await screen.findByText("Workspace is empty")).toBeVisible();
    expect(screen.getByRole("link", { name: "Add invoice" })).toHaveAttribute("href", "/");
    expect(screen.queryByText("Loading invoices…")).not.toBeInTheDocument();
  });

  it("renders the compact metrics, status tabs, and run ledger", async () => {
    window.history.replaceState({}, "", "/dashboard");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            items: [
              {
                runId: "11111111-1111-4111-8111-111111111111",
                filename: "multiple_issues.pdf",
                vendor: "Delta Components Ltd",
                invoiceNumber: "DELTA-2026-011",
                total: "181.50",
                currency: "USD",
                state: "NEEDS_REVIEW",
                decision: "NEEDS_REVIEW",
                execution: "BLOCKED",
                reasonCode: "MULTIPLE_ISSUES",
                ledgerId: null,
                createdAt: "2026-07-08T10:00:00.000Z",
                updatedAt: "2026-07-08T10:01:00.000Z",
              },
            ],
            nextCursor: null,
            metrics: {
              totalRuns: 1,
              postedCount: 0,
              reviewCount: 1,
              autoClearRate: "0.0",
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    render(<RouterProvider router={getRouter()} />);

    expect(
      await screen.findByRole("heading", { name: "Recent invoice runs" }),
    ).toBeVisible();
    expect(screen.getByText("Requires attention")).toBeVisible();
    expect(
      screen.getByRole("button", { name: /Needs review 1/ }),
    ).toBeVisible();
    expect(
      screen.getByRole("columnheader", { name: "Vendor · invoice" }),
    ).toBeVisible();
    expect(
      screen.getByRole("columnheader", { name: "Received" }),
    ).toBeVisible();
    expect(screen.getByText("Delta Components Ltd")).toBeVisible();
    expect(screen.queryByText(/demo/i)).not.toBeInTheDocument();
  });
});
