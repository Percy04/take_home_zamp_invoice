// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { RouterProvider } from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getRouter } from "../client/src/router";
import * as store from "../client/src/lib/store";
import * as api from "../client/src/lib/api";
import type { Run } from "../client/src/lib/types";

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
  it("uses the dashboard as home and uploads invoices from a modal", async () => {
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

    vi.spyOn(api, "createRun").mockResolvedValue({
      runId: "11111111-1111-4111-8111-111111111111",
    } as Run);
    const router = getRouter();
    render(<RouterProvider router={router} />);

    expect(await screen.findByText("Workspace is empty")).toBeVisible();
    expect(screen.queryByText("Intake")).not.toBeInTheDocument();
    expect(screen.queryByText("Activity")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add invoice" }));
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Upload an invoice" }),
    ).toBeVisible();

    fireEvent.change(screen.getByLabelText("Invoice PDF"), {
      target: {
        files: [
          new File(["invoice"], "invoice.pdf", { type: "application/pdf" }),
        ],
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload and process" }));

    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        "/runs/11111111-1111-4111-8111-111111111111",
      ),
    );
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
    expect(
      screen.getByRole("link", { name: "AP Resolution dashboard" }),
    ).toHaveAttribute("href", "/dashboard");
    expect(
      screen.getByRole("link", { name: "Delta Components Ltd" }),
    ).toHaveClass("after:absolute");
    expect(screen.queryByText(/demo/i)).not.toBeInTheDocument();
  });
});
