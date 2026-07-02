import { beforeEach, describe, expect, it, vi } from "vitest";

const activityMocks = vi.hoisted(() => {
  const app = {
    recordStepStarted: vi.fn(() => Promise.resolve(undefined)),
    recordStepSucceeded: vi.fn(() => Promise.resolve(undefined)),
    hasReviewedItemsToApply: vi.fn(() => Promise.resolve(false)),
    hasOpenReviewItems: vi.fn(() => Promise.resolve(false)),
    detectDuplicateCandidates: vi.fn(() => Promise.resolve({ duplicatesFound: 0 })),
    createReviewItemsForCandidates: vi.fn(() => Promise.resolve({ reviewItemsCreated: 0 })),
    markWaitingForReview: vi.fn(() => Promise.resolve(undefined)),
    applyReviewedItems: vi.fn(() => Promise.resolve({ applied: 0 })),
    commitApprovedCandidates: vi.fn(() => Promise.resolve({ questionsCommitted: 0 })),
    markWorkflowCompleted: vi.fn(() => Promise.resolve(undefined)),
    markWorkflowFailed: vi.fn(() => Promise.resolve(undefined))
  };
  const ocr = {
    runOcrAndPersist: vi.fn(() => Promise.resolve({ pagesProcessed: 1, model: "mistral-ocr-latest" })),
    submitOcrBatch: vi.fn(() => Promise.resolve({ providerJobId: "batch-ocr" })),
    importOcrBatchAndPersist: vi.fn(() => Promise.resolve({ pagesProcessed: 1 })),
    retryOcrBatchImport: vi.fn(() => Promise.resolve({ pagesProcessed: 1 }))
  };
  const llm = {
    extractQuestionsAndPersist: vi.fn(() => Promise.resolve({ candidatesExtracted: 1 })),
    solveQuestionsAndPersist: vi.fn(() => Promise.resolve({ candidatesSolved: 1 })),
    submitSegmentationBatch: vi.fn(() => Promise.resolve({ providerJobId: "batch-segmentation" })),
    importSegmentationBatchAndPersist: vi.fn(() => Promise.resolve({ candidatesExtracted: 1 })),
    submitSolvingBatch: vi.fn(() => Promise.resolve({ providerJobId: "batch-solving" })),
    importSolvingBatchAndPersist: vi.fn(() => Promise.resolve({ candidatesSolved: 1 })),
    retryLlmBatchImport: vi.fn(() => Promise.resolve({ candidatesSolved: 1 }))
  };

  return { app, ocr, llm };
});

vi.mock("@temporalio/workflow", () => ({
  condition: vi.fn(() => Promise.resolve(undefined)),
  defineSignal: vi.fn(() => "humanReviewCompleted"),
  setHandler: vi.fn(),
  proxyActivities: vi.fn((options?: { taskQueue?: string }) => {
    if (options?.taskQueue === "paper-ocr") {
      return activityMocks.ocr;
    }
    if (options?.taskQueue === "paper-llm-extraction") {
      return activityMocks.llm;
    }
    return activityMocks.app;
  })
}));

const { PaperIngestionWorkflow } = await import("./paper-ingestion.workflow.js");

describe("PaperIngestionWorkflow execution mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs OCR, extraction, and solving without provider batch jobs in sync mode", async () => {
    await PaperIngestionWorkflow({
      ingestionRunId: "run-sync",
      sourcePaperId: "source-1",
      executionMode: "sync"
    });

    expect(activityMocks.ocr.runOcrAndPersist).toHaveBeenCalledOnce();
    expect(activityMocks.llm.extractQuestionsAndPersist).toHaveBeenCalledOnce();
    expect(activityMocks.llm.solveQuestionsAndPersist).toHaveBeenCalledOnce();
    expect(activityMocks.ocr.submitOcrBatch).not.toHaveBeenCalled();
    expect(activityMocks.llm.submitSegmentationBatch).not.toHaveBeenCalled();
    expect(activityMocks.llm.submitSolvingBatch).not.toHaveBeenCalled();
  });

  it("uses the existing provider batch path in batch mode", async () => {
    await PaperIngestionWorkflow({
      ingestionRunId: "run-batch",
      sourcePaperId: "source-1",
      executionMode: "batch"
    });

    expect(activityMocks.ocr.submitOcrBatch).toHaveBeenCalledOnce();
    expect(activityMocks.ocr.importOcrBatchAndPersist).toHaveBeenCalledOnce();
    expect(activityMocks.llm.submitSegmentationBatch).toHaveBeenCalledOnce();
    expect(activityMocks.llm.importSegmentationBatchAndPersist).toHaveBeenCalledOnce();
    expect(activityMocks.llm.submitSolvingBatch).toHaveBeenCalledOnce();
    expect(activityMocks.llm.importSolvingBatchAndPersist).toHaveBeenCalledOnce();
    expect(activityMocks.ocr.runOcrAndPersist).not.toHaveBeenCalled();
    expect(activityMocks.llm.extractQuestionsAndPersist).not.toHaveBeenCalled();
    expect(activityMocks.llm.solveQuestionsAndPersist).not.toHaveBeenCalled();
  });
});
