import { prisma, WorkflowType } from "@queans/db";

import type { ApiConfig } from "./config.js";
import { startPaperIngestionWorkflow } from "./temporal.js";

export async function dispatchPendingWorkflowStarts(config: ApiConfig, limit = 10) {
  const pending = await prisma.workflowStartOutbox.findMany({
    where: { status: "PENDING" },
    include: { workflowRun: true },
    orderBy: { createdAt: "asc" },
    take: limit
  });

  for (const item of pending) {
    try {
      if (item.workflowRun.workflowType !== WorkflowType.PAPER_INGESTION || !item.workflowRun.sourcePaperId) {
        throw new Error(`Unsupported workflow outbox item ${item.id}`);
      }

      const workflowId = await startPaperIngestionWorkflow(config, {
        ingestionRunId: item.workflowRunId,
        sourcePaperId: item.workflowRun.sourcePaperId
      });

      await prisma.$transaction([
        prisma.workflowRun.update({
          where: { id: item.workflowRunId },
          data: {
            temporalRunId: workflowId,
            status: "RUNNING",
            currentStep: "store_file"
          }
        }),
        prisma.workflowStartOutbox.update({
          where: { id: item.id },
          data: { status: "STARTED", attemptCount: { increment: 1 }, lastError: null }
        }),
        prisma.workflowEvent.create({
          data: {
            workflowRunId: item.workflowRunId,
            eventType: "WORKFLOW_STARTED",
            eventPayload: { temporalWorkflowId: workflowId }
          }
        })
      ]);
    } catch (error) {
      await prisma.workflowStartOutbox.update({
        where: { id: item.id },
        data: {
          status: "FAILED",
          attemptCount: { increment: 1 },
          lastError: error instanceof Error ? error.message : "Unknown workflow dispatch error"
        }
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

