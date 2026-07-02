import { describe, expect, it } from "vitest";

import {
  completableWorkflowStepWhere,
  failedWorkflowStepTargetWhere,
  runningWorkflowStepWhere,
  sourcePaperFailedUpdate,
  sourcePaperUpdateForStartedWorkflowStep,
  workflowFailedEventCreateData,
  workflowRunCanFailWhere,
  workflowRunFailedUpdate,
  workflowRunUpdateForStartedStep,
  workflowStepCompletedEventCreateData,
  workflowStepCreateData,
  workflowStepFailedUpdate,
  workflowStepSucceededUpdate
} from "./app.activities.js";

const workflowInput = {
  ingestionRunId: "run-1",
  sourcePaperId: "source-paper-1"
};

const failurePayload = {
  message: "Mistral request failed",
  type: "Error",
  stack: "Error: Mistral request failed"
};

describe("runningWorkflowStepWhere", () => {
  it("matches only the currently running step for the run", () => {
    expect(runningWorkflowStepWhere(workflowInput, "run_ocr")).toEqual({
      workflowRunId: "run-1",
      stepName: "run_ocr",
      status: "RUNNING"
    });
  });
});

describe("workflowStepCreateData", () => {
  it("starts a first attempt for a new workflow step", () => {
    const data = workflowStepCreateData(workflowInput, "run_ocr");

    expect(data.startedAt).toBeInstanceOf(Date);
    expect({ ...data, startedAt: undefined }).toEqual({
      workflowRunId: "run-1",
      stepName: "run_ocr",
      status: "RUNNING",
      attemptCount: 1,
      startedAt: undefined
    });
  });
});

describe("completableWorkflowStepWhere", () => {
  it("matches running and already-succeeded steps so activity retries are idempotent", () => {
    expect(completableWorkflowStepWhere(workflowInput, "run_ocr")).toEqual({
      workflowRunId: "run-1",
      stepName: "run_ocr",
      status: { in: ["RUNNING", "SUCCEEDED"] }
    });
  });
});

describe("workflowStepSucceededUpdate", () => {
  it("stores the completion payload and timestamp", () => {
    const completedAt = new Date("2026-07-02T10:00:00.000Z");

    expect(workflowStepSucceededUpdate({ pagesProcessed: 2 }, completedAt)).toEqual({
      status: "SUCCEEDED",
      completedAt,
      outputPayload: { pagesProcessed: 2 }
    });
  });
});

describe("workflowStepCompletedEventCreateData", () => {
  it("records a deterministic completion event for the finished step", () => {
    expect(workflowStepCompletedEventCreateData(workflowInput, "run_ocr", { pagesProcessed: 2 })).toEqual({
      workflowRunId: "run-1",
      eventType: "RUN_OCR_COMPLETED",
      eventPayload: { pagesProcessed: 2 }
    });
  });
});

describe("workflowRunUpdateForStartedStep", () => {
  it("moves the run pointer to the started step", () => {
    expect(workflowRunUpdateForStartedStep("extract_question_candidates")).toEqual({
      status: "RUNNING",
      currentStep: "extract_question_candidates"
    });
  });
});

describe("sourcePaperUpdateForStartedWorkflowStep", () => {
  it("marks the source paper as processing while workflow activities run", () => {
    expect(sourcePaperUpdateForStartedWorkflowStep()).toEqual({
      status: "PROCESSING"
    });
  });
});

describe("failedWorkflowStepTargetWhere", () => {
  it("targets only the running step when recording a workflow failure", () => {
    expect(failedWorkflowStepTargetWhere(workflowInput, "run_ocr")).toEqual({
      workflowRunId: "run-1",
      stepName: "run_ocr",
      status: "RUNNING"
    });
  });
});

describe("workflowRunCanFailWhere", () => {
  it("prevents duplicate failure recording after a run reaches a terminal state", () => {
    expect(workflowRunCanFailWhere(workflowInput)).toEqual({
      id: "run-1",
      status: { in: ["PENDING", "RUNNING", "WAITING_FOR_REVIEW"] }
    });
  });
});

describe("workflowStepFailedUpdate", () => {
  it("stores the failure payload on the running step", () => {
    const completedAt = new Date("2026-07-02T10:00:00.000Z");

    expect(workflowStepFailedUpdate(failurePayload, completedAt)).toEqual({
      status: "FAILED",
      completedAt,
      errorPayload: failurePayload
    });
  });
});

describe("workflowRunFailedUpdate", () => {
  it("stores the terminal failure state on the workflow run", () => {
    const completedAt = new Date("2026-07-02T10:00:00.000Z");

    expect(workflowRunFailedUpdate("run_ocr", failurePayload, completedAt)).toEqual({
      status: "FAILED",
      currentStep: "run_ocr",
      errorPayload: failurePayload,
      completedAt
    });
  });
});

describe("sourcePaperFailedUpdate", () => {
  it("marks the source paper as failed with the terminal workflow", () => {
    expect(sourcePaperFailedUpdate()).toEqual({
      status: "FAILED"
    });
  });
});

describe("workflowFailedEventCreateData", () => {
  it("records the failed step in the workflow failure event payload", () => {
    expect(workflowFailedEventCreateData(workflowInput, "run_ocr", failurePayload)).toEqual({
      workflowRunId: "run-1",
      eventType: "WORKFLOW_FAILED",
      eventPayload: {
        stepName: "run_ocr",
        ...failurePayload
      }
    });
  });
});
