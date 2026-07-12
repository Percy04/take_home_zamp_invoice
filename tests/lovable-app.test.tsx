// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { RouterProvider } from "@tanstack/react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { getRouter } from "../frontend_v1/ap-resolve-console/src/router";

describe("main Lovable frontend", () => {
  beforeEach(() => window.history.replaceState({}, "", "/"));

  it("renders the complete Lovable intake experience", async () => {
    render(<RouterProvider router={getRouter()} />);

    expect(await screen.findByRole("heading", { name: "Upload an invoice" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Demo scenarios" })).toBeVisible();
    expect(screen.getByRole("button", { name: /Unknown bundle/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Mapping failed/ })).toBeVisible();
  });
});
