import { describe, expect, it } from "vitest";

import {
  runningWorkflowStepWhere,
  sourcePaperUpdateForStartedWorkflowStep,
  workflowRunUpdateForStartedStep,
  workflowStepCreateData
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
