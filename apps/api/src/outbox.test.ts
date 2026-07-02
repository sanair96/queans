import { describe, expect, it } from "vitest";

import {
  retryableWorkflowStartOutboxWhere,
  workflowDispatchFailureUpdate,
  workflowDispatchSuccessOutboxUpdate,
  workflowDispatchSuccessRunUpdate,
  workflowDispatchSuccessSourcePaperUpdate,
  workflowStartedEventPayload
} from "./outbox.js";

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

  it("marks the run, source paper, and outbox as started after Temporal accepts dispatch", () => {
    const startedWorkflow = {
      workflowId: "paper-ingestion/workflow-run-1",
      temporalRunId: "temporal-run-1"
    };

    expect(workflowDispatchSuccessRunUpdate(startedWorkflow)).toEqual({
      temporalRunId: "temporal-run-1",
      status: "RUNNING",
      currentStep: "store_file"
    });
    expect(workflowDispatchSuccessSourcePaperUpdate()).toEqual({
      status: "PROCESSING"
    });
    expect(workflowDispatchSuccessOutboxUpdate()).toEqual({
      status: "STARTED",
      attemptCount: { increment: 1 },
      lastError: null
    });
  });

  it("records both the Temporal workflow id and run id in the started event payload", () => {
    expect(
      workflowStartedEventPayload({
        workflowId: "paper-ingestion/workflow-run-1",
        temporalRunId: "temporal-run-1"
      })
    ).toEqual({
      temporalWorkflowId: "paper-ingestion/workflow-run-1",
      temporalRunId: "temporal-run-1"
    });
  });
});
