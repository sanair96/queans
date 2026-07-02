import {
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
  WorkflowIdConflictPolicy,
  WorkflowIdReusePolicy
} from "@temporalio/client";

import { paperIngestionWorkflowId, PAPER_INGESTION_WORKFLOW_TYPE } from "@queans/core";

import type { ApiConfig } from "./config.js";

let temporalClient: Client | undefined;

export interface StartedPaperIngestionWorkflow {
  workflowId: string;
  temporalRunId: string;
}

export async function getTemporalClient(config: ApiConfig) {
  if (temporalClient) {
    return temporalClient;
  }

  const connection = await Connection.connect({ address: config.TEMPORAL_ADDRESS });
  temporalClient = new Client({
    connection,
    namespace: config.TEMPORAL_NAMESPACE
  });
  return temporalClient;
}

export async function startPaperIngestionWorkflow(
  config: ApiConfig,
  input: {
    ingestionRunId: string;
    sourcePaperId: string;
  }
): Promise<StartedPaperIngestionWorkflow> {
  const client = await getTemporalClient(config);
  const workflowId = paperIngestionWorkflowId(input.ingestionRunId);
  try {
    const handle = await client.workflow.start(PAPER_INGESTION_WORKFLOW_TYPE, {
      taskQueue: config.TEMPORAL_TASK_QUEUE_PAPER_INGESTION,
      workflowId,
      workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
      workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
      args: [
        {
          ...input,
          taskQueues: {
            ocr: config.TEMPORAL_TASK_QUEUE_OCR,
            llm: config.TEMPORAL_TASK_QUEUE_LLM
          }
        }
      ]
    });
    return {
      workflowId,
      temporalRunId: handle.firstExecutionRunId
    };
  } catch (error) {
    if (error instanceof WorkflowExecutionAlreadyStartedError) {
      const existingWorkflow = client.workflow.getHandle(workflowId);
      const description = await existingWorkflow.describe();
      return {
        workflowId,
        temporalRunId: description.runId
      };
    }
    throw error;
  }
}

export async function signalHumanReviewCompleted(
  config: ApiConfig,
  input: {
    ingestionRunId: string;
    reviewedBy?: string;
  }
) {
  const client = await getTemporalClient(config);
  const workflowId = paperIngestionWorkflowId(input.ingestionRunId);
  const handle = client.workflow.getHandle(workflowId);
  await handle.signal("humanReviewCompleted", {
    workflowRunId: input.ingestionRunId,
    reviewedBy: input.reviewedBy
  });
}
