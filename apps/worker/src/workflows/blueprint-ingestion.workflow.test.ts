import { beforeEach, describe, expect, it, vi } from "vitest";

const activityMocks = vi.hoisted(() => ({
  beginBlueprintWorkflow: vi.fn(() => Promise.resolve(undefined)),
  ocrBlueprintDocument: vi.fn(() => Promise.resolve(undefined)),
  analyzeBlueprintStructure: vi.fn(() => Promise.resolve(undefined)),
  extractBlueprintRules: vi.fn(() => Promise.resolve(undefined)),
  persistBlueprintDraft: vi.fn(() => Promise.resolve(undefined)),
  completeBlueprintWorkflow: vi.fn(() => Promise.resolve(undefined)),
  failBlueprintWorkflow: vi.fn(() => Promise.resolve(undefined))
}));

vi.mock("@temporalio/workflow", () => ({
  proxyActivities: vi.fn(() => activityMocks)
}));

const { BlueprintIngestionWorkflow } = await import("./blueprint-ingestion.workflow.js");

const input = {
  workflowRunId: "run-1",
  blueprintDocumentId: "blueprint-1",
  mode: "FULL" as const
};

describe("BlueprintIngestionWorkflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activityMocks.beginBlueprintWorkflow.mockResolvedValue(undefined);
    activityMocks.ocrBlueprintDocument.mockResolvedValue(undefined);
    activityMocks.analyzeBlueprintStructure.mockResolvedValue(undefined);
    activityMocks.extractBlueprintRules.mockResolvedValue(undefined);
    activityMocks.persistBlueprintDraft.mockResolvedValue(undefined);
    activityMocks.completeBlueprintWorkflow.mockResolvedValue(undefined);
    activityMocks.failBlueprintWorkflow.mockResolvedValue(undefined);
  });

  it("orchestrates Blueprint activities using identifier-only payloads", async () => {
    await BlueprintIngestionWorkflow(input);

    for (const activity of [
      activityMocks.beginBlueprintWorkflow,
      activityMocks.ocrBlueprintDocument,
      activityMocks.analyzeBlueprintStructure,
      activityMocks.extractBlueprintRules,
      activityMocks.persistBlueprintDraft,
      activityMocks.completeBlueprintWorkflow
    ]) {
      expect(activity).toHaveBeenCalledOnce();
      expect(activity).toHaveBeenCalledWith(input);
    }
    expect(activityMocks.failBlueprintWorkflow).not.toHaveBeenCalled();
  });

  it("records a failure using the same identifier-only payload", async () => {
    activityMocks.extractBlueprintRules.mockRejectedValueOnce(new Error("provider unavailable"));

    await expect(BlueprintIngestionWorkflow(input)).rejects.toThrow("provider unavailable");
    expect(activityMocks.persistBlueprintDraft).not.toHaveBeenCalled();
    expect(activityMocks.completeBlueprintWorkflow).not.toHaveBeenCalled();
    expect(activityMocks.failBlueprintWorkflow).toHaveBeenCalledOnce();
    expect(activityMocks.failBlueprintWorkflow).toHaveBeenCalledWith(input);
  });

  it("resumes extraction from stored OCR without invoking OCR again", async () => {
    const resumeInput = { ...input, mode: "RESUME_FROM_OCR" as const };

    await BlueprintIngestionWorkflow(resumeInput);

    expect(activityMocks.beginBlueprintWorkflow).toHaveBeenCalledWith(resumeInput);
    expect(activityMocks.ocrBlueprintDocument).not.toHaveBeenCalled();
    expect(activityMocks.analyzeBlueprintStructure).toHaveBeenCalledWith(resumeInput);
    expect(activityMocks.extractBlueprintRules).toHaveBeenCalledWith(resumeInput);
    expect(activityMocks.persistBlueprintDraft).toHaveBeenCalledWith(resumeInput);
    expect(activityMocks.completeBlueprintWorkflow).toHaveBeenCalledWith(resumeInput);
  });
});
