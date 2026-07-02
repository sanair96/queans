import { describe, expect, it } from "vitest";

import {
  completableWorkflowStepWhere,
  runningWorkflowStepWhere,
  sourcePaperUpdateForStartedWorkflowStep,
  workflowRunUpdateForStartedStep,
  workflowStepCompletedEventCreateData,
  workflowStepCreateData,
  workflowStepSucceededUpdate
} from "./app.activities.js";

const workflowInput = {
  ingestionRunId: "run-1",
  sourcePaperId: "source-paper-1"
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
