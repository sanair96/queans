import type { BlueprintIngestionWorkflowInput } from "@queans/core";
import { Prisma, prisma } from "@queans/db";

export async function beginBlueprintWorkflow(input: BlueprintIngestionWorkflowInput) {
  const claimed = await prisma.workflowRun.updateMany({
    where: {
      id: input.workflowRunId,
      workflowType: "BLUEPRINT_INGESTION",
      blueprintDocumentId: input.blueprintDocumentId,
      status: "PENDING"
    },
    data: {
      status: "RUNNING",
      currentStep: "ocr_document"
    }
  });
  if (claimed.count === 0) {
    return { started: false };
  }

  await prisma.$transaction([
    prisma.blueprintDocument.updateMany({
      where: {
        id: input.blueprintDocumentId,
        status: { in: ["QUEUED", "PROCESSING"] }
      },
      data: { status: "PROCESSING" }
    }),
    prisma.workflowEvent.create({
      data: {
        workflowRunId: input.workflowRunId,
        eventType: "BLUEPRINT_PROCESSING_STARTED",
        eventPayload: { blueprintDocumentId: input.blueprintDocumentId }
      }
    })
  ]);

  return { started: true };
}

export async function completeBlueprintWorkflow(input: BlueprintIngestionWorkflowInput) {
  const claimed = await prisma.workflowRun.updateMany({
    where: {
      id: input.workflowRunId,
      workflowType: "BLUEPRINT_INGESTION",
      blueprintDocumentId: input.blueprintDocumentId,
      status: "RUNNING"
    },
    data: {
      status: "COMPLETED",
      currentStep: "complete",
      completedAt: new Date()
    }
  });
  if (claimed.count === 0) {
    return { completed: false };
  }

  await prisma.$transaction([
    prisma.blueprintDocument.updateMany({
      where: {
        id: input.blueprintDocumentId,
        status: "PROCESSING",
        draftRulesJson: { not: Prisma.JsonNull }
      },
      data: { status: "READY_FOR_APPROVAL" }
    }),
    prisma.workflowEvent.create({
      data: {
        workflowRunId: input.workflowRunId,
        eventType: "BLUEPRINT_WORKFLOW_COMPLETED",
        eventPayload: { blueprintDocumentId: input.blueprintDocumentId }
      }
    })
  ]);

  return { completed: true };
}

export async function failBlueprintWorkflow(input: BlueprintIngestionWorkflowInput) {
  const claimed = await prisma.workflowRun.updateMany({
    where: {
      id: input.workflowRunId,
      workflowType: "BLUEPRINT_INGESTION",
      blueprintDocumentId: input.blueprintDocumentId,
      status: { in: ["PENDING", "RUNNING"] }
    },
    data: {
      status: "FAILED",
      errorPayload: { code: "BLUEPRINT_WORKFLOW_FAILED" },
      completedAt: new Date()
    }
  });
  if (claimed.count === 0) {
    return { failed: false };
  }

  await prisma.$transaction([
    prisma.blueprintDocument.updateMany({
      where: {
        id: input.blueprintDocumentId,
        status: { in: ["QUEUED", "PROCESSING"] }
      },
      data: {
        status: "FAILED",
        extractionError: "Blueprint ingestion workflow failed."
      }
    }),
    prisma.workflowEvent.create({
      data: {
        workflowRunId: input.workflowRunId,
        eventType: "BLUEPRINT_WORKFLOW_FAILED",
        eventPayload: { blueprintDocumentId: input.blueprintDocumentId }
      }
    })
  ]);

  return { failed: true };
}
