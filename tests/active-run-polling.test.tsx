// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, waitFor } from "@testing-library/react";
import { RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRouter } from "../frontend_v1/ap-resolve-console/src/router";
import * as store from "../frontend_v1/ap-resolve-console/src/lib/store";
import type { Run } from "../frontend_v1/ap-resolve-console/src/lib/types";
import * as api from "../frontend_v1/ap-resolve-console/src/lib/api";

vi.mock("../frontend_v1/ap-resolve-console/src/lib/api", () => ({
  getRun: vi.fn(),
  processRun: vi.fn(),
  resetWorkspace: vi.fn(),
  documentUrl: vi.fn(() => "/document.pdf"),
}));

vi.mock(
  "../frontend_v1/ap-resolve-console/src/components/DocumentPreview",
  () => ({
    DocumentPreview: () => <div>Source document</div>,
  }),
);

const run = {
  runId: "11111111-1111-4111-8111-111111111111",
  filename: "invoice.pdf",
  state: "PROCESSING",
  execution: "PENDING",
  reasonCode: null,
  nextAction: null,
  ledgerId: null,
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T00:00:00.000Z",
  stages: [],
  invoice: null,
  checks: [],
  activity: [],
} satisfies Run;

describe("active run polling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.clearRuns();
    store.upsertRun(run);
    window.history.replaceState({}, "", `/runs/${run.runId}`);
    vi.mocked(api.getRun).mockResolvedValue(run);
    vi.mocked(api.processRun).mockResolvedValue(run);
  });

  afterEach(() => {
    store.clearRuns();
  });

  it("starts processing once and polls server stages while the run is active", async () => {
    render(<RouterProvider router={getRouter()} />);

    await waitFor(() => expect(api.processRun).toHaveBeenCalledWith(run.runId));
    await waitFor(() => expect(api.getRun).toHaveBeenCalledTimes(2), {
      timeout: 1_000,
    });
  });
});
