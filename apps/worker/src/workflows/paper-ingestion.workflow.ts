import { condition, defineSignal, proxyActivities, setHandler } from "@temporalio/workflow";

import {
  PAPER_LLM_TASK_QUEUE,
  PAPER_OCR_TASK_QUEUE,
  type HumanReviewCompletedSignal,
  type PaperIngestionWorkflowInput
} from "@queans/core";

import type * as appActivities from "../activities/app.activities.js";
import type * as llmActivities from "../activities/llm.activities.js";
import type * as ocrActivities from "../activities/ocr.activities.js";

const app = proxyActivities<typeof appActivities>({
  startToCloseTimeout: "1 minute",
  retry: {
    maximumAttempts: 5
  }
});

const ocr = proxyActivities<typeof ocrActivities>({
  taskQueue: PAPER_OCR_TASK_QUEUE,
  startToCloseTimeout: "20 minutes",
  retry: {
    maximumAttempts: 3
  }
});

const llm = proxyActivities<typeof llmActivities>({
  taskQueue: PAPER_LLM_TASK_QUEUE,
  startToCloseTimeout: "20 minutes",
  retry: {
    maximumAttempts: 3
  }
});

export const humanReviewCompleted = defineSignal<[HumanReviewCompletedSignal]>("humanReviewCompleted");

export async function PaperIngestionWorkflow(input: PaperIngestionWorkflowInput) {
  let reviewSignalCount = 0;
  setHandler(humanReviewCompleted, () => {
    reviewSignalCount += 1;
  });

  await app.recordStepStarted(input, "store_file");
  await app.recordStepSucceeded(input, "store_file", { sourcePaperId: input.sourcePaperId });

  await app.recordStepStarted(input, "run_ocr");
  await ocr.runOcrAndPersist(input);
  await app.recordStepSucceeded(input, "run_ocr", {});

  await app.recordStepStarted(input, "extract_question_candidates");
  const extraction = await llm.extractQuestionsAndPersist(input);
  await app.recordStepSucceeded(input, "extract_question_candidates", extraction);

  await app.recordStepStarted(input, "validate_candidates");
  const reviewSummary = await app.createReviewItemsForCandidates(input);
  await app.recordStepSucceeded(input, "validate_candidates", reviewSummary);

  while (await app.hasOpenReviewItems(input)) {
    const previousSignalCount = reviewSignalCount;
    await app.markWaitingForReview(input);
    await condition(() => reviewSignalCount > previousSignalCount);
    await app.recordStepStarted(input, "apply_human_corrections");
    await app.applyReviewedItems(input);
    await app.recordStepSucceeded(input, "apply_human_corrections", {});
  }

  await app.recordStepStarted(input, "commit_to_question_bank");
  const commitSummary = await app.commitApprovedCandidates(input);
  await app.recordStepSucceeded(input, "commit_to_question_bank", commitSummary);

  await app.markWorkflowCompleted(input);
}

