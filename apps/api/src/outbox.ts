import { prisma, WorkflowType } from "@queans/db";
import type { Prisma } from "@queans/db";

import type { ApiConfig } from "./config.js";
import { startPaperIngestionWorkflow } from "./temporal.js";
import type { StartedPaperIngestionWorkflow } from "./temporal.js";

export const WORKFLOW_DISPATCH_MAX_ATTEMPTS = 12;

export function retryableWorkflowStartOutboxWhere(
  maxAttempts = WORKFLOW_DISPATCH_MAX_ATTEMPTS
): Prisma.WorkflowStartOutboxWhereInput {
  return {
    OR: [
      { status: "PENDING" },
      {
        status: "FAILED",
        attemptCount: { lt: maxAttempts }
      }
    ]
  };
}

export function workflowDispatchFailureUpdate(error: unknown): Prisma.WorkflowStartOutboxUpdateInput {
  return {
    status: "FAILED",
    attemptCount: { increment: 1 },
    lastError: error instanceof Error ? error.message : "Unknown workflow dispatch error"
  };
}

export function workflowDispatchSuccessRunUpdate(startedWorkflow: StartedPaperIngestionWorkflow) {
  return {
    temporalRunId: startedWorkflow.temporalRunId,
    status: "RUNNING",
    currentStep: "store_file"
  } satisfies Prisma.WorkflowRunUpdateInput;
}

export function workflowStartedEventPayload(startedWorkflow: StartedPaperIngestionWorkflow) {
  return {
    temporalWorkflowId: startedWorkflow.workflowId,
    temporalRunId: startedWorkflow.temporalRunId
  };
}

export function workflowDispatchSuccessSourcePaperUpdate() {
  return {
    status: "PROCESSING"
  } satisfies Prisma.SourcePaperUpdateInput;
}

export function workflowDispatchSuccessOutboxUpdate() {
  return {
    status: "STARTED",
    attemptCount: { increment: 1 },
    lastError: null
  } satisfies Prisma.WorkflowStartOutboxUpdateInput;
}

export async function dispatchPendingWorkflowStarts(config: ApiConfig, limit = 10, maxAttempts = WORKFLOW_DISPATCH_MAX_ATTEMPTS) {
  const pending = await prisma.workflowStartOutbox.findMany({
    where: retryableWorkflowStartOutboxWhere(maxAttempts),
    include: { workflowRun: true },
    orderBy: { createdAt: "asc" },
    take: limit
  });

  for (const item of pending) {
    try {
      if (item.workflowRun.workflowType !== WorkflowType.PAPER_INGESTION || !item.workflowRun.sourcePaperId) {
        throw new Error(`Unsupported workflow outbox item ${item.id}`);
      }

      const startedWorkflow = await startPaperIngestionWorkflow(config, {
        ingestionRunId: item.workflowRunId,
        sourcePaperId: item.workflowRun.sourcePaperId
      });

      await prisma.$transaction([
        prisma.workflowRun.update({
          where: { id: item.workflowRunId },
          data: workflowDispatchSuccessRunUpdate(startedWorkflow)
        }),
        prisma.sourcePaper.update({
          where: { id: item.workflowRun.sourcePaperId },
          data: workflowDispatchSuccessSourcePaperUpdate()
        }),
        prisma.workflowStartOutbox.update({
          where: { id: item.id },
          data: workflowDispatchSuccessOutboxUpdate()
        }),
        prisma.workflowEvent.create({
          data: {
            workflowRunId: item.workflowRunId,
            eventType: "WORKFLOW_STARTED",
            eventPayload: workflowStartedEventPayload(startedWorkflow)
          }
        })
      ]);
    } catch (error) {
      await prisma.workflowStartOutbox.update({
        where: { id: item.id },
        data: workflowDispatchFailureUpdate(error)
      });
    }
  }
}

export function startOutboxDispatcher(config: ApiConfig) {
  const interval = setInterval(() => {
    dispatchPendingWorkflowStarts(config).catch((error: unknown) => {
      console.error("Workflow outbox dispatch failed", error);
    });
  }, 2500);

  return () => clearInterval(interval);
}
