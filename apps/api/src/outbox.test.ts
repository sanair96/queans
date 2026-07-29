import { describe, expect, it } from "vitest";

import {
  dispatchableWorkflowStartOutboxWhere,
  retryableWorkflowStartOutboxWhere,
  workflowDispatchClaimUpdate,
  workflowDispatchClaimWhere,
  workflowDispatchFailureUpdate,
  workflowDispatchStaleBefore,
  workflowDispatchSuccessOutboxUpdate,
  workflowDispatchSuccessRunUpdate,
  workflowDispatchSuccessSourcePaperUpdate,
  workflowStartedEventPayload
} from "./outbox.js";

describe("workflow start outbox helpers", () => {
  it("dispatches paper and Blueprint workflow starts", () => {
    const staleBefore = new Date("2026-07-02T10:00:00.000Z");

    expect(dispatchableWorkflowStartOutboxWhere(3, staleBefore)).toMatchObject({
      workflowRun: { workflowType: { in: ["PAPER_INGESTION", "BLUEPRINT_INGESTION"] } }
    });
  });

  it("selects pending rows and failed rows below the retry cap", () => {
    const staleBefore = new Date("2026-07-02T10:00:00.000Z");

    expect(retryableWorkflowStartOutboxWhere(3, staleBefore)).toEqual({
      OR: [
        { status: "PENDING" },
        {
          status: "FAILED",
          attemptCount: { lt: 3 }
        },
        {
          status: "DISPATCHING",
          attemptCount: { lt: 3 },
          OR: [{ lockedAt: null }, { lockedAt: { lt: staleBefore } }]
        }
      ]
    });
  });

  it("claims one retryable row before calling Temporal", () => {
    const staleBefore = new Date("2026-07-02T10:00:00.000Z");
    const lockedAt = new Date("2026-07-02T10:05:00.000Z");

    expect(workflowDispatchClaimWhere("outbox-1", 3, staleBefore)).toEqual({
      id: "outbox-1",
      OR: [
        { status: "PENDING" },
        {
          status: "FAILED",
          attemptCount: { lt: 3 }
        },
        {
          status: "DISPATCHING",
          attemptCount: { lt: 3 },
          OR: [{ lockedAt: null }, { lockedAt: { lt: staleBefore } }]
        }
      ]
    });
    expect(workflowDispatchClaimUpdate(lockedAt)).toEqual({
      status: "DISPATCHING",
      attemptCount: { increment: 1 },
      lockedAt,
      lastError: null
    });
  });

  it("computes the stale dispatch cutoff from the configured lease window", () => {
    expect(workflowDispatchStaleBefore(new Date("2026-07-02T10:05:00.000Z"))).toEqual(
      new Date("2026-07-02T10:00:00.000Z")
    );
  });

  it("records a useful error message for dispatch failures", () => {
    expect(workflowDispatchFailureUpdate(new Error("temporal unavailable"))).toEqual({
      status: "FAILED",
      lockedAt: null,
      lastError: "temporal unavailable"
    });
  });

  it("records an opaque message for non-error dispatch failures", () => {
    expect(workflowDispatchFailureUpdate("failed")).toEqual({
      status: "FAILED",
      lockedAt: null,
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
      lockedAt: null,
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
