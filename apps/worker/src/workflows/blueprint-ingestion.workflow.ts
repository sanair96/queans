import { proxyActivities } from "@temporalio/workflow";

import { type BlueprintIngestionWorkflowInput } from "@queans/core";

export interface BlueprintIngestionActivities {
  beginBlueprintWorkflow(input: BlueprintIngestionWorkflowInput): Promise<void>;
  ocrBlueprintDocument(input: BlueprintIngestionWorkflowInput): Promise<void>;
  analyzeBlueprintStructure(input: BlueprintIngestionWorkflowInput): Promise<void>;
  extractBlueprintRules(input: BlueprintIngestionWorkflowInput): Promise<void>;
  persistBlueprintDraft(input: BlueprintIngestionWorkflowInput): Promise<void>;
  completeBlueprintWorkflow(input: BlueprintIngestionWorkflowInput): Promise<void>;
  failBlueprintWorkflow(input: BlueprintIngestionWorkflowInput): Promise<void>;
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
  try {
    await activities.beginBlueprintWorkflow(input);
    if (input.mode === "FULL") {
      await activities.ocrBlueprintDocument(input);
    }
    await activities.analyzeBlueprintStructure(input);
    await activities.extractBlueprintRules(input);
    await activities.persistBlueprintDraft(input);
    await activities.completeBlueprintWorkflow(input);
  } catch (error) {
    await activities.failBlueprintWorkflow(input);
    throw error;
  }
}
