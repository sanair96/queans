import { condition, defineSignal, proxyActivities, setHandler } from "@temporalio/workflow";

import {
  PAPER_LLM_TASK_QUEUE,
  PAPER_OCR_TASK_QUEUE,
  serializeWorkflowFailure,
  type PaperIngestionStep,
  type HumanReviewCompletedSignal,
  type PaperIngestionWorkflowInput
} from "@queans/core";

import type * as appActivities from "../activities/app.activities.js";
import type * as llmActivities from "../activities/llm.activities.js";
import type * as ocrActivities from "../activities/ocr.activities.js";
import { humanReviewRecheckInterval, shouldWaitForHumanReviewSignal } from "./review-wait.js";

const app = proxyActivities<typeof appActivities>({
  startToCloseTimeout: "1 minute",
  retry: {
    maximumAttempts: 5
  }
});

export const humanReviewCompleted = defineSignal<[HumanReviewCompletedSignal]>("humanReviewCompleted");

export async function PaperIngestionWorkflow(input: PaperIngestionWorkflowInput) {
  let reviewSignalCount = 0;
  let currentStep: PaperIngestionStep = "store_file";
  setHandler(humanReviewCompleted, () => {
    reviewSignalCount += 1;
  });

  const ocr = proxyActivities<typeof ocrActivities>({
    taskQueue: input.taskQueues?.ocr ?? PAPER_OCR_TASK_QUEUE,
    startToCloseTimeout: "20 minutes",
    retry: {
      maximumAttempts: 3
    }
  });

  const llm = proxyActivities<typeof llmActivities>({
    taskQueue: input.taskQueues?.llm ?? PAPER_LLM_TASK_QUEUE,
    startToCloseTimeout: "20 minutes",
    retry: {
      maximumAttempts: 3
    }
  });

  try {
    async function applyReviewedItemsIfAny() {
      const hasReviewedItems = await app.hasReviewedItemsToApply(input);
      if (!hasReviewedItems) {
        return;
      }

      currentStep = "apply_human_corrections";
      await app.recordStepStarted(input, "apply_human_corrections");
      const applySummary = await app.applyReviewedItems(input);
      await app.recordStepSucceeded(input, "apply_human_corrections", applySummary);
      currentStep = "wait_for_review";
    }

    currentStep = "store_file";
    await app.recordStepStarted(input, "store_file");
    await app.recordStepSucceeded(input, "store_file", { sourcePaperId: input.sourcePaperId });

    let shouldImportSolvingBatch = input.retryImportOperation === "question_solving";

    if (!input.retryImportBatchJobId) {
      currentStep = "submit_ocr_batch";
      await app.recordStepStarted(input, "submit_ocr_batch");
      const ocrBatch = await ocr.submitOcrBatch(input);
      await app.recordStepSucceeded(input, "submit_ocr_batch", ocrBatch);
    }

    if (!input.retryImportBatchJobId || input.retryImportOperation === "ocr") {
      currentStep = "import_ocr_batch";
      await app.recordStepStarted(input, "import_ocr_batch");
      const ocrImport =
        input.retryImportBatchJobId && input.retryImportOperation === "ocr"
          ? await ocr.retryOcrBatchImport(input, input.retryImportBatchJobId)
          : await ocr.importOcrBatchAndPersist(input);
      await app.recordStepSucceeded(input, "import_ocr_batch", ocrImport);
    }

    if (!input.retryImportBatchJobId || input.retryImportOperation === "ocr") {
      currentStep = "submit_segmentation_batch";
      await app.recordStepStarted(input, "submit_segmentation_batch");
      const segmentationBatch = await llm.submitSegmentationBatch(input);
      await app.recordStepSucceeded(input, "submit_segmentation_batch", segmentationBatch);
    }

    if (!input.retryImportBatchJobId || input.retryImportOperation === "ocr" || input.retryImportOperation === "question_segmentation") {
      currentStep = "import_segmentation_batch";
      await app.recordStepStarted(input, "import_segmentation_batch");
      const segmentation =
        input.retryImportBatchJobId && input.retryImportOperation === "question_segmentation"
          ? await llm.retryLlmBatchImport(input, input.retryImportBatchJobId)
          : await llm.importSegmentationBatchAndPersist(input);
      await app.recordStepSucceeded(input, "import_segmentation_batch", segmentation);
    }

    if (
      !input.retryImportBatchJobId ||
      input.retryImportOperation === "ocr" ||
      input.retryImportOperation === "question_segmentation"
    ) {
      currentStep = "submit_solving_batch";
      await app.recordStepStarted(input, "submit_solving_batch");
      const solvingBatch = await llm.submitSolvingBatch(input);
      await app.recordStepSucceeded(input, "submit_solving_batch", solvingBatch);
      shouldImportSolvingBatch = !("skipped" in solvingBatch);
    }

    if (shouldImportSolvingBatch) {
      currentStep = "import_solving_batch";
      await app.recordStepStarted(input, "import_solving_batch");
      const solving =
        input.retryImportBatchJobId && input.retryImportOperation === "question_solving"
          ? await llm.retryLlmBatchImport(input, input.retryImportBatchJobId)
          : await llm.importSolvingBatchAndPersist(input);
      await app.recordStepSucceeded(input, "import_solving_batch", solving);
    }

    currentStep = "dedupe_check";
    await app.recordStepStarted(input, "dedupe_check");
    const duplicateSummary = await app.detectDuplicateCandidates(input);
    await app.recordStepSucceeded(input, "dedupe_check", duplicateSummary);

    currentStep = "validate_candidates";
    await app.recordStepStarted(input, "validate_candidates");
    const reviewSummary = await app.createReviewItemsForCandidates(input);
    await app.recordStepSucceeded(input, "validate_candidates", reviewSummary);

    while (await app.hasOpenReviewItems(input)) {
      while (true) {
        currentStep = "wait_for_review";
        await app.markWaitingForReview(input);

        const previousSignalCount = reviewSignalCount;
        const reviewStillOpen = await app.hasOpenReviewItems(input);
        if (!reviewStillOpen) {
          break;
        }

        if (
          shouldWaitForHumanReviewSignal({
            reviewStillOpen,
            previousSignalCount,
            currentSignalCount: reviewSignalCount
          })
        ) {
          await condition(() => reviewSignalCount > previousSignalCount, humanReviewRecheckInterval);
        }

        await applyReviewedItemsIfAny();
      }
    }
    await applyReviewedItemsIfAny();

    currentStep = "commit_to_question_bank";
    await app.recordStepStarted(input, "commit_to_question_bank");
    const commitSummary = await app.commitApprovedCandidates(input);
    await app.recordStepSucceeded(input, "commit_to_question_bank", commitSummary);

    currentStep = "complete";
    await app.markWorkflowCompleted(input, commitSummary);
  } catch (error) {
    await app.markWorkflowFailed(input, currentStep, serializeWorkflowFailure(error));
    throw error;
  }
}
