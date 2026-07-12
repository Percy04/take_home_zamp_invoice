// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { RouterProvider } from "@tanstack/react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRouter } from "../frontend_v1/ap-resolve-console/src/router";

vi.mock("react-pdf", () => ({
  pdfjs: { GlobalWorkerOptions: {} },
  Document: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  Page: () => <div>PDF page</div>,
}));

describe("main Lovable frontend", () => {
  beforeEach(() => window.history.replaceState({}, "", "/"));

  it("renders the complete Lovable intake experience", async () => {
    render(<RouterProvider router={getRouter()} />);

    expect(
      await screen.findByRole("heading", { name: "Upload an invoice" }),
    ).toBeVisible();
    expect(
      screen.getByRole("region", { name: "Prepared invoices" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: /Unknown bundle/ }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: /Tax inclusive/ })).toBeVisible();
    expect(screen.queryByText(/demo/i)).not.toBeInTheDocument();
  });
});
