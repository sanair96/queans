import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply } from "fastify";

import { reviewPatchSchema, uploadCompleteSchema, uploadInitSchema } from "@queans/core";
import { Prisma, prisma, WorkflowStatus } from "@queans/db";
import { loadR2ConfigFromEnv, R2ObjectStore } from "@queans/providers";

import type { UploadCompleteInput } from "@queans/core";
import type { ApiConfig } from "./config.js";
import { dispatchPendingWorkflowStarts } from "./outbox.js";
import { checkReadiness } from "./readiness.js";
import { signalHumanReviewCompleted } from "./temporal.js";
import { toInputJson, toNullableInputJson } from "./json.js";

interface IdParams {
  id: string;
}

export function registerRoutes(app: FastifyInstance, config: ApiConfig) {
  app.get("/health", () => ({ ok: true }));

  app.get("/ready", async (_request, reply) => {
    const result = await checkReadiness(config);
    return reply.code(result.ok ? 200 : 503).send(result);
  });

  app.post("/api/uploads/init", async (request, reply) => {
    const input = uploadInitSchema.parse(request.body);
    const r2 = getR2ObjectStoreOrReply(reply);
    if (!r2) {
      return reply;
    }

    const objectKey = buildSourcePaperObjectKey(input.fileName);
    const presigned = await r2.createPresignedPut({
      objectKey,
      contentType: input.mimeType,
      byteSize: input.byteSize,
      checksumSha256: input.checksumSha256
    });
    const upload = await prisma.uploadObject.create({
      data: {
        objectKey,
        fileName: input.fileName,
        mimeType: input.mimeType,
        byteSize: BigInt(input.byteSize),
        checksumSha256: input.checksumSha256 ?? null
      }
    });

    return reply.code(201).send({
      uploadId: upload.id,
      objectKey,
      uploadUrl: presigned.url,
      expiresAt: presigned.expiresAt.toISOString()
    });
  });

  app.post<{ Params: IdParams }>("/api/uploads/:id/complete", async (request, reply) => {
    const input = uploadCompleteSchema.parse(request.body);
    const r2 = getR2ObjectStoreOrReply(reply);
    if (!r2) {
      return reply;
    }

    const paperContextPayload = input.paperContext === undefined ? null : toInputJson(input.paperContext);
    const upload = await prisma.uploadObject.findUnique({
      where: { id: request.params.id },
      include: { sourcePaper: { include: { workflowRuns: { orderBy: { createdAt: "desc" }, take: 1 } } } }
    });

    if (!upload) {
      return reply.code(404).send({ error: "UPLOAD_NOT_FOUND" });
    }

    if (upload.status === "COMPLETED" && upload.sourcePaper) {
      return reply.send(uploadCompletionPayload(upload.sourcePaper));
    }

    const head = await r2.headObject(upload.objectKey);
    if (input.byteSize !== undefined && head.byteSize !== input.byteSize) {
      return reply.code(409).send({ error: "UPLOAD_SIZE_MISMATCH" });
    }

    if (head.byteSize !== Number(upload.byteSize)) {
      return reply.code(409).send({ error: "R2_OBJECT_SIZE_MISMATCH" });
    }

    let result;
    try {
      result = await prisma.$transaction(async (tx) => {
        const completedUpload = await tx.uploadObject.update({
          where: { id: upload.id },
          data: {
            status: "COMPLETED",
            etag: input.etag ?? head.etag ?? null,
            completedAt: new Date()
          }
        });
        const sourcePaper = await tx.sourcePaper.create({
          data: {
            uploadObjectId: completedUpload.id,
            ...sourcePaperContextData(input.paperContext),
            sourceFileName: completedUpload.fileName,
            status: "QUEUED"
          }
        });
        const workflowRun = await tx.workflowRun.create({
          data: {
            workflowType: "PAPER_INGESTION",
            entityId: sourcePaper.id,
            sourcePaperId: sourcePaper.id,
            status: "PENDING",
            currentStep: "store_file",
            inputPayload: {
              sourcePaperId: sourcePaper.id,
              uploadObjectId: completedUpload.id,
              objectKey: completedUpload.objectKey,
              paperContext: paperContextPayload,
              taskQueues: {
                paperIngestion: config.TEMPORAL_TASK_QUEUE_PAPER_INGESTION,
                ocr: config.TEMPORAL_TASK_QUEUE_OCR,
                llm: config.TEMPORAL_TASK_QUEUE_LLM
              }
            }
          }
        });
        await tx.workflowStartOutbox.create({
          data: {
            workflowRunId: workflowRun.id
          }
        });
        await tx.workflowEvent.create({
          data: {
            workflowRunId: workflowRun.id,
            eventType: "UPLOAD_COMPLETED",
            eventPayload: {
              uploadObjectId: completedUpload.id,
              objectKey: completedUpload.objectKey,
              paperContext: paperContextPayload
            }
          }
        });
        return { sourcePaper, workflowRun };
      });
    } catch (error) {
      if (isPrismaUniqueConstraintError(error)) {
        const existing = await findUploadCompletionPayload(upload.id);
        if (existing) {
          return reply.send(existing);
        }
      }
      throw error;
    }

    dispatchPendingWorkflowStarts(config).catch((error: unknown) => {
      request.log.error({ error }, "Workflow dispatch failed after upload completion");
    });

    return reply.code(202).send({
      sourcePaperId: result.sourcePaper.id,
      ingestionRunId: result.workflowRun.id,
      status: "QUEUED"
    });
  });

  app.post<{ Params: IdParams }>("/api/papers/:id/ingestions", async (request, reply) => {
    const [sourcePaper, activeRun] = await Promise.all([
      prisma.sourcePaper.findUnique({ where: { id: request.params.id } }),
      prisma.workflowRun.findFirst({
        where: {
          sourcePaperId: request.params.id,
          workflowType: "PAPER_INGESTION",
          status: { in: activeIngestionStatuses() }
        },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          status: true
        }
      })
    ]);
    if (!sourcePaper) {
      return reply.code(404).send({ error: "SOURCE_PAPER_NOT_FOUND" });
    }

    if (activeRun) {
      return reply.code(202).send(ingestionQueuedPayload(activeRun));
    }

    const workflowRun = await prisma.$transaction(async (tx) => {
      const run = await tx.workflowRun.create({
        data: {
          workflowType: "PAPER_INGESTION",
          entityId: sourcePaper.id,
          sourcePaperId: sourcePaper.id,
          status: "PENDING",
          currentStep: "store_file",
          inputPayload: {
            sourcePaperId: sourcePaper.id,
            taskQueues: {
              paperIngestion: config.TEMPORAL_TASK_QUEUE_PAPER_INGESTION,
              ocr: config.TEMPORAL_TASK_QUEUE_OCR,
              llm: config.TEMPORAL_TASK_QUEUE_LLM
            }
          }
        }
      });
      await tx.workflowStartOutbox.create({ data: { workflowRunId: run.id } });
      await tx.sourcePaper.update({ where: { id: sourcePaper.id }, data: { status: "QUEUED" } });
      return run;
    });

    dispatchPendingWorkflowStarts(config).catch((error: unknown) => {
      request.log.error({ error }, "Workflow dispatch failed after manual ingestion start");
    });

    return reply.code(202).send({
      ingestionRunId: workflowRun.id,
      status: "QUEUED"
    });
  });

  app.get<{ Params: IdParams }>("/api/ingestions/:id", async (request, reply) => {
    const workflowRun = await prisma.workflowRun.findUnique({
      where: { id: request.params.id },
      include: {
        steps: { orderBy: { startedAt: "asc" } },
        events: { orderBy: { createdAt: "asc" }, take: 50 },
        providerRunCosts: true,
        sourcePaper: {
          include: {
            _count: {
              select: {
                questionCandidates: true,
                reviewItems: true,
                ocrPages: true
              }
            }
          }
        }
      }
    });

    if (!workflowRun) {
      return reply.code(404).send({ error: "INGESTION_RUN_NOT_FOUND" });
    }

    return {
      id: workflowRun.id,
      status: workflowRun.status,
      currentStep: workflowRun.currentStep,
      sourcePaperId: workflowRun.sourcePaperId,
      counts: workflowRun.sourcePaper?._count,
      steps: workflowRun.steps,
      events: workflowRun.events,
      costs: workflowRun.providerRunCosts
    };
  });

  app.get("/api/review/tasks", async () => {
    const reviewItems = await prisma.reviewItem.findMany({
      where: { status: { in: ["OPEN", "ASSIGNED"] } },
      include: {
        candidate: true,
        sourcePaper: true
      },
      orderBy: [{ severity: "desc" }, { createdAt: "asc" }],
      take: 100
    });

    return { reviewItems };
  });

  app.patch<{ Params: IdParams }>("/api/review/tasks/:id", async (request, reply) => {
    const input = reviewPatchSchema.parse(request.body);
    const reviewItem = await prisma.reviewItem.findUnique({
      where: { id: request.params.id },
      include: {
        sourcePaper: {
          include: {
            workflowRuns: {
              orderBy: { createdAt: "desc" },
              take: 1
            }
          }
        }
      }
    });

    if (!reviewItem) {
      return reply.code(404).send({ error: "REVIEW_ITEM_NOT_FOUND" });
    }

    await prisma.$transaction(async (tx) => {
      await tx.reviewItem.update({
        where: { id: reviewItem.id },
        data: {
          status: reviewStatusForDecision(input.decision),
          reviewedBy: input.reviewedBy ?? null,
          reviewNotes: input.reviewNotes ?? null,
          reviewPayload: toNullableInputJson(input.reviewPayload),
          decision: input.decision,
          reviewedAt: new Date()
        }
      });

      for (const correction of input.corrections ?? []) {
        await tx.reviewCorrection.create({
          data: {
            reviewItemId: reviewItem.id,
            fieldName: correction.fieldName,
            oldValue: toNullableInputJson(correction.oldValue),
            newValue: toNullableInputJson(correction.newValue),
            correctionType: correction.correctionType,
            reviewerId: input.reviewedBy ?? null
          }
        });
      }
    });

    const latestRun = reviewItem.sourcePaper.workflowRuns[0];
    if (latestRun) {
      const signalInput = input.reviewedBy
        ? { ingestionRunId: latestRun.id, reviewedBy: input.reviewedBy }
        : { ingestionRunId: latestRun.id };
      signalHumanReviewCompleted(config, {
        ...signalInput
      }).catch((error: unknown) => {
        request.log.error({ error }, "Temporal review signal failed");
      });
    }

    return { ok: true };
  });

  app.get("/api/questions", async () => {
    const questions = await prisma.question.findMany({
      where: { status: "APPROVED" },
      include: {
        answers: true,
        chapter: true,
        topic: true,
        subtopic: true
      },
      orderBy: { createdAt: "desc" },
      take: 100
    });

    return { questions };
  });

  app.post("/api/internal/dispatch-workflows", async () => {
    await dispatchPendingWorkflowStarts(config);
    return { ok: true };
  });
}

function getR2ObjectStoreOrReply(reply: FastifyReply) {
  try {
    return new R2ObjectStore(loadR2ConfigFromEnv(process.env));
  } catch (error) {
    reply.code(503).send({
      error: "R2_CONFIGURATION_ERROR",
      message: error instanceof Error ? error.message : "R2 configuration is invalid"
    });
    return undefined;
  }
}

function buildSourcePaperObjectKey(fileName: string) {
  const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const datePrefix = new Date().toISOString().slice(0, 10);
  return `source-papers/${datePrefix}/${randomUUID()}-${safeFileName}`;
}

function sourcePaperContextData(paperContext: UploadCompleteInput["paperContext"]) {
  return {
    title: paperContext?.title ?? null,
    board: paperContext?.board ?? null,
    classLevel: paperContext?.classLevel ?? null,
    subject: paperContext?.subject ?? null,
    year: paperContext?.year ?? null,
    schoolName: paperContext?.schoolName ?? null,
    examType: paperContext?.examType ?? null,
    uploadedBy: paperContext?.uploadedBy ?? null,
    metadata: toNullableInputJson(paperContext?.metadata)
  };
}

export function uploadCompletionPayload(sourcePaper: {
  id: string;
  workflowRuns: Array<{ id: string; status: string }>;
}) {
  const latestRun = sourcePaper.workflowRuns[0];
  return {
    sourcePaperId: sourcePaper.id,
    ingestionRunId: latestRun?.id,
    status: latestRun?.status ?? "PENDING"
  };
}

async function findUploadCompletionPayload(uploadId: string) {
  const upload = await prisma.uploadObject.findUnique({
    where: { id: uploadId },
    include: { sourcePaper: { include: { workflowRuns: { orderBy: { createdAt: "desc" }, take: 1 } } } }
  });

  return upload?.sourcePaper ? uploadCompletionPayload(upload.sourcePaper) : undefined;
}

export function isPrismaUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export function activeIngestionStatuses() {
  return [WorkflowStatus.PENDING, WorkflowStatus.RUNNING, WorkflowStatus.WAITING_FOR_REVIEW];
}

export function isActiveIngestionStatus(status: string) {
  return activeIngestionStatuses().some((activeStatus) => activeStatus === status);
}

export function ingestionQueuedPayload(workflowRun: { id: string; status: string }) {
  return {
    ingestionRunId: workflowRun.id,
    status: workflowRun.status === WorkflowStatus.PENDING ? "QUEUED" : workflowRun.status
  };
}

function reviewStatusForDecision(decision: string) {
  switch (decision) {
    case "APPROVE":
      return "APPROVED";
    case "EDIT_AND_APPROVE":
    case "SPLIT":
    case "MERGE":
      return "EDITED";
    case "REJECT":
    case "MARK_UNPROCESSABLE":
      return "REJECTED";
    case "MARK_DUPLICATE":
      return "SKIPPED";
    case "NEEDS_MORE_INFO":
      return "ASSIGNED";
    default:
      return "OPEN";
  }
}
