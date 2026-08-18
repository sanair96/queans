import { describe, expect, it } from "vitest";
import {
  BLUEPRINT_INGESTION_TASK_QUEUE,
  BLUEPRINT_INGESTION_WORKFLOW_TYPE,
  PAPER_INGESTION_TASK_QUEUE,
  PAPER_INGESTION_WORKFLOW_TYPE,
  blueprintIngestionWorkflowId,
  paperIngestionWorkflowId
} from "./workflow.js";

describe("Source-paper workflow contract", () => {
  it("uses its own workflow type, task queue, and deterministic workflow identifier", () => {
    expect(PAPER_INGESTION_WORKFLOW_TYPE).toBe("PaperIngestionWorkflow");
    expect(PAPER_INGESTION_TASK_QUEUE).toBe("paper-ingestion");
    expect(paperIngestionWorkflowId("run-1")).toBe("paper-ingestion/run-1");
  });
});

describe("Blueprint workflow contract", () => {
  it("uses a dedicated workflow type, task queue, and deterministic workflow identifier", () => {
    expect(BLUEPRINT_INGESTION_WORKFLOW_TYPE).toBe("BlueprintIngestionWorkflow");
    expect(BLUEPRINT_INGESTION_TASK_QUEUE).toBe("blueprint-ingestion");
    expect(blueprintIngestionWorkflowId("run-1")).toBe("blueprint-ingestion/run-1");
  });
});
