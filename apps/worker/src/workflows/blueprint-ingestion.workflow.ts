import { proxyActivities } from "@temporalio/workflow";

import { type BlueprintIngestionWorkflowInput } from "@queans/core";

export interface BlueprintIngestionActivities {
  beginBlueprintWorkflow(input: BlueprintIngestionWorkflowInput): Promise<void>;
  ocrBlueprintDocument(input: BlueprintIngestionWorkflowInput): Promise<void>;
  analyzeBlueprintStructure(input: BlueprintIngestionWorkflowInput): Promise<void>;
  extractBlueprintRules(input: BlueprintIngestionWorkflowInput): Promise<void>;
  persistBlueprintDraft(input: BlueprintIngestionWorkflowInput): Promise<void>;
  completeBlueprintWorkflow(input: BlueprintIngestionWorkflowInput): Promise<void>;
  failBlueprintWorkflow(input: BlueprintIngestionWorkflowInput, failure: BlueprintWorkflowFailure): Promise<void>;
}

export interface BlueprintWorkflowFailure {
  step: string;
  message: string;
}

const activities = proxyActivities<BlueprintIngestionActivities>({
  startToCloseTimeout: "20 minutes",
  retry: {
    maximumAttempts: 3
  }
});

/**
 * The workflow moves only identifiers through Temporal. Each activity loads
 * and persists its own document data, OCR, and extraction results.
 */
export async function BlueprintIngestionWorkflow(input: BlueprintIngestionWorkflowInput) {
  let step = "start Blueprint ingestion";
  try {
    step = "start workflow";
    await activities.beginBlueprintWorkflow(input);
    if (input.mode === "FULL") {
      step = "OCR";
      await activities.ocrBlueprintDocument(input);
    }
    step = "language and structure analysis";
    await activities.analyzeBlueprintStructure(input);
    step = "marking-scheme extraction";
    await activities.extractBlueprintRules(input);
    step = "save extracted draft";
    await activities.persistBlueprintDraft(input);
    step = "complete workflow";
    await activities.completeBlueprintWorkflow(input);
  } catch (error) {
    await activities.failBlueprintWorkflow(input, { step, message: workflowFailureMessage(error) });
    throw error;
  }
}

function workflowFailureMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown failure";
  return message.replace(/https?:\/\/\S+/gu, "[redacted URL]").slice(0, 1_000);
}
