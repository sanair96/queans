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
import { shouldWaitForHumanReviewSignal } from "./review-wait.js";

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
    currentStep = "store_file";
    await app.recordStepStarted(input, "store_file");
    await app.recordStepSucceeded(input, "store_file", { sourcePaperId: input.sourcePaperId });

    currentStep = "run_ocr";
    await app.recordStepStarted(input, "run_ocr");
    await ocr.runOcrAndPersist(input);
    await app.recordStepSucceeded(input, "run_ocr", {});

    currentStep = "extract_question_candidates";
    await app.recordStepStarted(input, "extract_question_candidates");
    const extraction = await llm.extractQuestionsAndPersist(input);
    await app.recordStepSucceeded(input, "extract_question_candidates", extraction);

    currentStep = "dedupe_check";
    await app.recordStepStarted(input, "dedupe_check");
    const duplicateSummary = await app.detectDuplicateCandidates(input);
    await app.recordStepSucceeded(input, "dedupe_check", duplicateSummary);

    currentStep = "validate_candidates";
    await app.recordStepStarted(input, "validate_candidates");
    const reviewSummary = await app.createReviewItemsForCandidates(input);
    await app.recordStepSucceeded(input, "validate_candidates", reviewSummary);

    while (await app.hasOpenReviewItems(input)) {
      currentStep = "wait_for_review";
      await app.markWaitingForReview(input);
      const previousSignalCount = reviewSignalCount;
      const reviewStillOpen = await app.hasOpenReviewItems(input);
      if (
        shouldWaitForHumanReviewSignal({
          reviewStillOpen,
          previousSignalCount,
          currentSignalCount: reviewSignalCount
        })
      ) {
        await condition(() => reviewSignalCount > previousSignalCount);
      }
      currentStep = "apply_human_corrections";
      await app.recordStepStarted(input, "apply_human_corrections");
      await app.applyReviewedItems(input);
      await app.recordStepSucceeded(input, "apply_human_corrections", {});
    }

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
