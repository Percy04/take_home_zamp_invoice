// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../client/src/app";

describe("App", () => {
  it("renders the product foundation", () => {
    render(<App />);

    expect(
      screen.getByRole("heading", { name: /upload an invoice/i }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: /^happy$/i })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: /bundle unknown/i }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: /upload and process/i }),
    ).toBeDisabled();
    expect(screen.getByRole("note")).toHaveTextContent(
      /pdf is sent to azure document intelligence/i,
    );
    expect(
      screen.getByRole("button", { name: /reset workspace/i }),
    ).toBeEnabled();
  });
});
