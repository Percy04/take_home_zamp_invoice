// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../client/src/app";

describe("App", () => {
  it("renders the product foundation", () => {
    render(<App />);

    expect(
      screen.getByRole("heading", { name: /ap operations console/i }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: /^happy$/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /bundle unknown/i })).toBeEnabled();
    expect(screen.getByRole("note")).toHaveTextContent(/synthetic data only/i);
  });
});
