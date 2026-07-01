import { describe, expect, it } from "vitest";

import { resolveWorkflowEntryPath } from "./workflow-entry.js";

describe("resolveWorkflowEntryPath", () => {
  it("uses source workflow TypeScript when the worker runs through tsx", () => {
    expect(resolveWorkflowEntryPath("file:///repo/apps/worker/src/index.ts")).toBe(
      "/repo/apps/worker/src/workflows/index.ts"
    );
  });

  it("uses emitted workflow JavaScript when the worker runs from dist", () => {
    expect(resolveWorkflowEntryPath("file:///repo/apps/worker/dist/apps/worker/src/index.js")).toBe(
      "/repo/apps/worker/dist/apps/worker/src/workflows/index.js"
    );
  });
});
