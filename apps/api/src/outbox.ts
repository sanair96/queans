import { prisma, WorkflowType } from "@queans/db";
import type { Prisma } from "@queans/db";

import type { ApiConfig } from "./config.js";
import { startPaperIngestionWorkflow } from "./temporal.js";
import type { StartedPaperIngestionWorkflow } from "./temporal.js";

export const WORKFLOW_DISPATCH_MAX_ATTEMPTS = 12;
export const WORKFLOW_DISPATCH_STALE_LOCK_MS = 5 * 60 * 1000;

export function retryableWorkflowStartOutboxWhere(
  maxAttempts = WORKFLOW_DISPATCH_MAX_ATTEMPTS,
  staleBefore = workflowDispatchStaleBefore()
): Prisma.WorkflowStartOutboxWhereInput {
  return {
    OR: [
      { status: "PENDING" },
      {
        status: "FAILED",
        attemptCount: { lt: maxAttempts }
      },
      {
        status: "DISPATCHING",
        attemptCount: { lt: maxAttempts },
        OR: [{ lockedAt: null }, { lockedAt: { lt: staleBefore } }]
      }
    ]
  };
}

export function workflowDispatchStaleBefore(now = new Date()) {
  return new Date(now.getTime() - WORKFLOW_DISPATCH_STALE_LOCK_MS);
}

export function workflowDispatchClaimWhere(
  id: string,
  maxAttempts = WORKFLOW_DISPATCH_MAX_ATTEMPTS,
  staleBefore = workflowDispatchStaleBefore()
) {
  return {
    id,
    ...retryableWorkflowStartOutboxWhere(maxAttempts, staleBefore)
  } satisfies Prisma.WorkflowStartOutboxWhereInput;
}

export function workflowDispatchClaimUpdate(lockedAt = new Date()) {
  return {
    status: "DISPATCHING",
    attemptCount: { increment: 1 },
    lockedAt,
    lastError: null
  } satisfies Prisma.WorkflowStartOutboxUpdateManyMutationInput;
}

export function workflowDispatchFailureUpdate(error: unknown): Prisma.WorkflowStartOutboxUpdateInput {
  return {
    status: "FAILED",
    lockedAt: null,
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
    lockedAt: null,
    lastError: null
  } satisfies Prisma.WorkflowStartOutboxUpdateInput;
}

export async function dispatchPendingWorkflowStarts(config: ApiConfig, limit = 10, maxAttempts = WORKFLOW_DISPATCH_MAX_ATTEMPTS) {
  const staleBefore = workflowDispatchStaleBefore();
  const pending = await prisma.workflowStartOutbox.findMany({
    where: retryableWorkflowStartOutboxWhere(maxAttempts, staleBefore),
    include: { workflowRun: true },
    orderBy: { createdAt: "asc" },
    take: limit
  });

  for (const item of pending) {
    const claim = await prisma.workflowStartOutbox.updateMany({
      where: workflowDispatchClaimWhere(item.id, maxAttempts, staleBefore),
      data: workflowDispatchClaimUpdate()
    });
    if (claim.count === 0) {
      continue;
    }

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
