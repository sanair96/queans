import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply } from "fastify";

import { reviewPatchSchema, summarizeWorkflowFailure, uploadCompleteSchema, uploadInitSchema } from "@queans/core";
import { Prisma, prisma, ReviewStatus, WorkflowStatus } from "@queans/db";
import { loadR2ConfigFromEnv, R2ObjectStore, type StoredObjectHead } from "@queans/providers";

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
    const uploadConflict = uploadCompletionConflict({
      head,
      reportedByteSize: input.byteSize,
      storedByteSize: upload.byteSize,
      storedMimeType: upload.mimeType
    });
    if (uploadConflict) {
      return reply.code(409).send(uploadConflict);
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
        _count: {
          select: {
            reviewItems: true
          }
        },
        steps: { orderBy: { startedAt: "asc" } },
        events: { orderBy: { createdAt: "asc" }, take: 50 },
        providerRunCosts: { orderBy: { createdAt: "asc" } },
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
      outputPayload: workflowRun.outputPayload,
      errorPayload: workflowRun.errorPayload,
      failureSummary: ingestionFailureSummary({
        errorPayload: workflowRun.errorPayload,
        currentStep: workflowRun.currentStep,
        providerRunCosts: workflowRun.providerRunCosts
      }),
      counts: workflowRun.sourcePaper
        ? ingestionRunCounts(workflowRun.sourcePaper._count, workflowRun._count.reviewItems)
        : undefined,
      steps: workflowRun.steps,
      events: workflowRun.events,
      costs: workflowRun.providerRunCosts
    };
  });

  app.get("/api/review/tasks", async () => {
    const reviewItems = await prisma.reviewItem.findMany({
      where: openReviewItemsWhere(),
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
        workflowRun: {
          select: {
            id: true,
            status: true
          }
        }
      }
    });

    if (!reviewItem) {
      return reply.code(404).send({ error: "REVIEW_ITEM_NOT_FOUND" });
    }

    if (!canPatchReviewItem(reviewItem)) {
      return reply.code(409).send(reviewItemAlreadyClosedPayload(reviewItem));
    }

    try {
      await prisma.$transaction(async (tx) => {
        const updateResult = await tx.reviewItem.updateMany({
          where: mutableReviewItemWhere(reviewItem.id),
          data: {
            status: reviewStatusForDecision(input.decision),
            reviewedBy: input.reviewedBy ?? null,
            reviewNotes: input.reviewNotes ?? null,
            reviewPayload: toNullableInputJson(input.reviewPayload),
            decision: input.decision,
            reviewedAt: new Date()
          }
        });

        if (updateResult.count === 0) {
          throw new ReviewItemAlreadyClosedError();
        }

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
    } catch (error) {
      if (!isReviewItemAlreadyClosedError(error)) {
        throw error;
      }

      const latestReviewItem = await prisma.reviewItem.findUnique({
        where: { id: reviewItem.id },
        select: { status: true, appliedAt: true }
      });
      return reply.code(409).send(reviewItemAlreadyClosedPayload(latestReviewItem ?? reviewItem));
    }

    const activeRun = reviewSignalRunForItem(reviewItem);
    if (activeRun) {
      const signalInput = input.reviewedBy
        ? { ingestionRunId: activeRun.id, reviewedBy: input.reviewedBy }
        : { ingestionRunId: activeRun.id };
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

interface UploadCompletionVerificationInput {
  head: StoredObjectHead;
  reportedByteSize: number | undefined;
  storedByteSize: bigint | number;
  storedMimeType: string;
}

export function uploadCompletionConflict(input: UploadCompletionVerificationInput) {
  if (input.reportedByteSize !== undefined && input.head.byteSize !== input.reportedByteSize) {
    return { error: "UPLOAD_SIZE_MISMATCH" };
  }

  if (input.head.byteSize !== Number(input.storedByteSize)) {
    return { error: "R2_OBJECT_SIZE_MISMATCH" };
  }

  const actualMimeType = normalizedMimeType(input.head.contentType);
  const expectedMimeType = normalizedMimeType(input.storedMimeType);
  if (actualMimeType !== expectedMimeType) {
    return {
      error: "R2_OBJECT_CONTENT_TYPE_MISMATCH",
      expectedMimeType,
      actualMimeType
    };
  }

  return undefined;
}

async function findUploadCompletionPayload(uploadId: string) {
  const upload = await prisma.uploadObject.findUnique({
    where: { id: uploadId },
    include: { sourcePaper: { include: { workflowRuns: { orderBy: { createdAt: "desc" }, take: 1 } } } }
  });

  return upload?.sourcePaper ? uploadCompletionPayload(upload.sourcePaper) : undefined;
}

function normalizedMimeType(value: string | undefined) {
  return value?.split(";")[0]?.trim().toLowerCase() || null;
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

export function ingestionRunCounts(
  sourcePaperCounts: {
    questionCandidates: number;
    reviewItems: number;
    ocrPages: number;
  },
  runReviewItems: number
) {
  return {
    ...sourcePaperCounts,
    reviewItems: runReviewItems
  };
}

export function ingestionFailureSummary(input: {
  errorPayload: unknown;
  currentStep?: string | null;
  providerRunCosts?: Array<{ provider: string; model: string; operation: string }>;
}) {
  if (!hasPayload(input.errorPayload)) {
    return null;
  }

  const cost = providerCostForStep(input.currentStep, input.providerRunCosts);
  return summarizeWorkflowFailure(input.errorPayload, ingestionFailureSummaryOptions(input.currentStep, cost));
}

function ingestionFailureSummaryOptions(
  failedStep: string | null | undefined,
  cost: { provider: string; model: string } | undefined
) {
  return {
    ...(failedStep ? { failedStep } : {}),
    ...(cost ? { provider: cost.provider, model: cost.model } : {})
  };
}

function providerCostForStep(
  stepName: string | null | undefined,
  providerRunCosts: Array<{ provider: string; model: string; operation: string }> | undefined
) {
  if (!providerRunCosts?.length) {
    return undefined;
  }

  const operation = stepNameToProviderOperation(stepName);
  if (operation) {
    return providerRunCosts.find((cost) => cost.operation === operation);
  }

  return providerRunCosts.at(-1);
}

function stepNameToProviderOperation(stepName: string | null | undefined) {
  if (stepName === "run_ocr") {
    return "ocr";
  }

  if (stepName === "extract_question_candidates") {
    return "question_extraction";
  }

  return undefined;
}

function hasPayload(value: unknown) {
  return value !== null && value !== undefined;
}

interface ReviewItemMutationState {
  status: ReviewStatus;
  appliedAt: Date | null;
}

const mutableReviewStatuses = [ReviewStatus.OPEN, ReviewStatus.ASSIGNED] as const;

export function openReviewItemsWhere() {
  return {
    status: { in: [...mutableReviewStatuses] },
    workflowRun: {
      workflowType: "PAPER_INGESTION",
      status: { in: activeIngestionStatuses() }
    }
  } satisfies Prisma.ReviewItemWhereInput;
}

export function canPatchReviewItem(reviewItem: ReviewItemMutationState) {
  return reviewItem.appliedAt === null && mutableReviewStatuses.some((status) => status === reviewItem.status);
}

export function mutableReviewItemWhere(id: string) {
  return {
    id,
    status: { in: [...mutableReviewStatuses] },
    appliedAt: null
  } satisfies Prisma.ReviewItemWhereInput;
}

export function reviewSignalRunForItem(reviewItem: { workflowRun: { id: string; status: string } }) {
  return isActiveIngestionStatus(reviewItem.workflowRun.status) ? reviewItem.workflowRun : undefined;
}

export function reviewItemAlreadyClosedPayload(reviewItem: ReviewItemMutationState) {
  return {
    error: "REVIEW_ITEM_ALREADY_CLOSED",
    status: reviewItem.status,
    appliedAt: reviewItem.appliedAt?.toISOString() ?? null
  };
}

class ReviewItemAlreadyClosedError extends Error {}

function isReviewItemAlreadyClosedError(error: unknown) {
  return error instanceof ReviewItemAlreadyClosedError;
}

function reviewStatusForDecision(decision: string) {
  switch (decision) {
    case "APPROVE":
      return ReviewStatus.APPROVED;
    case "EDIT_AND_APPROVE":
      return ReviewStatus.EDITED;
    case "REJECT":
    case "MARK_UNPROCESSABLE":
      return ReviewStatus.REJECTED;
    case "MARK_DUPLICATE":
      return ReviewStatus.SKIPPED;
    case "NEEDS_MORE_INFO":
      return ReviewStatus.ASSIGNED;
    default:
      return ReviewStatus.OPEN;
  }
}
