import { describe, expect, it } from "vitest";

import { retryableWorkflowStartOutboxWhere, workflowDispatchFailureUpdate } from "./outbox.js";

describe("workflow start outbox helpers", () => {
  it("selects pending rows and failed rows below the retry cap", () => {
    expect(retryableWorkflowStartOutboxWhere(3)).toEqual({
      OR: [
        { status: "PENDING" },
        {
          status: "FAILED",
          attemptCount: { lt: 3 }
        }
      ]
    });
  });

  it("records a useful error message for dispatch failures", () => {
    expect(workflowDispatchFailureUpdate(new Error("temporal unavailable"))).toEqual({
      status: "FAILED",
      attemptCount: { increment: 1 },
      lastError: "temporal unavailable"
    });
  });

  it("records an opaque message for non-error dispatch failures", () => {
    expect(workflowDispatchFailureUpdate("failed")).toEqual({
      status: "FAILED",
      attemptCount: { increment: 1 },
      lastError: "Unknown workflow dispatch error"
    });
  });
});
