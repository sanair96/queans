import { randomUUID, timingSafeEqual } from "node:crypto";

import type { FastifyInstance, FastifyReply } from "fastify";

import {
  reviewPatchSchema,
  reviewReasonCodes,
  summarizeWorkflowFailure,
  uploadCompleteSchema,
  uploadInitSchema
} from "@queans/core";
import { Prisma, prisma, ProviderBatchJobStatus, ReviewStatus, WorkflowStatus } from "@queans/db";
import { loadR2ConfigFromEnv, R2ObjectStore, type StoredObjectHead } from "@queans/providers";

import type { ReviewPatchInput, ReviewReasonCode, UploadCompleteInput } from "@queans/core";
import type { ApiConfig } from "./config.js";
import { dispatchPendingWorkflowStarts } from "./outbox.js";
import { checkReadiness } from "./readiness.js";
import { signalHumanReviewCompleted } from "./temporal.js";
import { toInputJson, toNullableInputJson } from "./json.js";

interface IdParams {
  id: string;
}

export const INTERNAL_API_TOKEN_HEADER = "x-queans-internal-token";

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
            inputPayload: paperIngestionInputPayload({
              sourcePaperId: sourcePaper.id,
              uploadObjectId: completedUpload.id,
              objectKey: completedUpload.objectKey,
              paperContext: paperContextPayload,
              config
            })
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
      prisma.sourcePaper.findUnique({
        where: { id: request.params.id },
        include: { uploadObject: true }
      }),
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

    const ingestion = await prisma.$transaction(async (tx) => {
      const claim = await tx.sourcePaper.updateMany({
        where: sourcePaperCanQueueIngestionWhere(sourcePaper.id),
        data: sourcePaperQueuedForIngestionUpdate()
      });

      if (claim.count === 0) {
        const existingRun = await tx.workflowRun.findFirst({
          where: {
            sourcePaperId: sourcePaper.id,
            workflowType: "PAPER_INGESTION",
            status: { in: activeIngestionStatuses() }
          },
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            status: true
          }
        });
        return existingRun ? { workflowRun: existingRun, claimed: false } : undefined;
      }

      const run = await tx.workflowRun.create({
        data: {
          workflowType: "PAPER_INGESTION",
          entityId: sourcePaper.id,
          sourcePaperId: sourcePaper.id,
          status: "PENDING",
          currentStep: "store_file",
          inputPayload: paperIngestionInputPayload({
            sourcePaperId: sourcePaper.id,
            uploadObjectId: sourcePaper.uploadObjectId,
            objectKey: sourcePaper.uploadObject.objectKey,
            paperContext: paperContextPayloadFromSourcePaper(sourcePaper),
            config
          })
        }
      });
      await tx.workflowStartOutbox.create({ data: { workflowRunId: run.id } });
      return { workflowRun: run, claimed: true };
    });

    if (!ingestion) {
      return reply.code(409).send({ error: "SOURCE_PAPER_INGESTION_ALREADY_ACTIVE" });
    }

    if (ingestion.claimed) {
      dispatchPendingWorkflowStarts(config).catch((error: unknown) => {
        request.log.error({ error }, "Workflow dispatch failed after manual ingestion start");
      });
    }

    return reply.code(202).send(ingestionQueuedPayload(ingestion.workflowRun));
  });

  app.get("/api/ingestions", async (request) => {
    const query = ingestionListQuery(request.query);
    const runs = await prisma.workflowRun.findMany({
      where: ingestionListWhere(query),
      include: {
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
        },
        steps: {
          orderBy: { startedAt: "desc" },
          take: 1
        },
        providerRunCosts: true,
        providerBatchJobs: {
          orderBy: { createdAt: "desc" },
          take: 3
        },
        _count: {
          select: {
            reviewItems: true
          }
        }
      },
      orderBy: { createdAt: "desc" },
      take: query.limit + 1,
      skip: query.offset
    });
    const page = runs.slice(0, query.limit);

    return {
      runs: page.map((run) => ({
        id: run.id,
        status: run.status,
        currentStep: run.currentStep,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        completedAt: run.completedAt,
        sourcePaperId: run.sourcePaperId,
        retryOfWorkflowRunId: run.retryOfWorkflowRunId,
        sourcePaper: run.sourcePaper
          ? {
              id: run.sourcePaper.id,
              title: run.sourcePaper.title,
              sourceFileName: run.sourcePaper.sourceFileName,
              status: run.sourcePaper.status
            }
          : null,
        latestStep: run.steps[0] ?? null,
        latestBatchJob: run.providerBatchJobs[0] ?? null,
        counts: run.sourcePaper
          ? ingestionRunCounts(run.sourcePaper._count, run._count.reviewItems)
          : undefined,
        estimatedCostUsd: totalEstimatedCostForRun(run.providerRunCosts)
      })),
      nextOffset: runs.length > query.limit ? query.offset + query.limit : null
    };
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
        providerBatchJobs: { orderBy: { createdAt: "asc" } },
        retryOfWorkflowRun: {
          select: {
            id: true,
            status: true,
            currentStep: true,
            createdAt: true
          }
        },
        retryAttempts: {
          select: {
            id: true,
            status: true,
            currentStep: true,
            createdAt: true
          },
          orderBy: { createdAt: "desc" }
        },
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
      retryOfWorkflowRun: workflowRun.retryOfWorkflowRun,
      retryAttempts: workflowRun.retryAttempts,
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
      costs: workflowRun.providerRunCosts,
      providerBatchJobs: workflowRun.providerBatchJobs
    };
  });

  app.post<{ Params: IdParams }>("/api/ingestions/:id/retry", async (request, reply) => {
    const force = retryForceFromBody(request.body);
    const run = await prisma.workflowRun.findUnique({
      where: { id: request.params.id },
      include: {
        sourcePaper: {
          include: { uploadObject: true }
        }
      }
    });

    if (!run?.sourcePaper) {
      return reply.code(404).send({ error: "INGESTION_RUN_NOT_FOUND" });
    }
    if (!canRetryWorkflowRun(run.status, force)) {
      return reply.code(409).send({ error: "INGESTION_RUN_NOT_RETRYABLE", status: run.status });
    }

    const activeRun = await activeIngestionRunForSourcePaper(run.sourcePaper.id);
    if (activeRun) {
      return reply.code(409).send({ error: "SOURCE_PAPER_INGESTION_ALREADY_ACTIVE", ingestionRunId: activeRun.id });
    }

    const retryRun = await createRetryWorkflowRun({
      sourcePaper: run.sourcePaper,
      config,
      retryOfWorkflowRunId: run.id
    });
    dispatchPendingWorkflowStarts(config).catch((error: unknown) => {
      request.log.error({ error }, "Workflow dispatch failed after ingestion retry");
    });

    return reply.code(202).send(ingestionQueuedPayload(retryRun));
  });

  app.post<{ Params: IdParams }>("/api/provider-batch-jobs/:id/retry-import", async (request, reply) => {
    const batchJob = await prisma.providerBatchJob.findUnique({
      where: { id: request.params.id },
      include: {
        workflowRun: true,
        sourcePaper: {
          include: { uploadObject: true }
        }
      }
    });

    if (!batchJob?.sourcePaper) {
      return reply.code(404).send({ error: "PROVIDER_BATCH_JOB_NOT_FOUND" });
    }
    if (!canRetryBatchImport(batchJob)) {
      return reply.code(409).send({ error: "PROVIDER_BATCH_JOB_IMPORT_NOT_RETRYABLE", status: batchJob.status });
    }

    const activeRun = await activeIngestionRunForSourcePaper(batchJob.sourcePaper.id);
    if (activeRun) {
      return reply.code(409).send({ error: "SOURCE_PAPER_INGESTION_ALREADY_ACTIVE", ingestionRunId: activeRun.id });
    }

    const retryRun = await createRetryWorkflowRun({
      sourcePaper: batchJob.sourcePaper,
      config,
      retryOfWorkflowRunId: batchJob.workflowRunId,
      retryImportBatchJobId: batchJob.id,
      retryImportOperation: providerBatchRetryOperation(batchJob.operation)
    });
    dispatchPendingWorkflowStarts(config).catch((error: unknown) => {
      request.log.error({ error }, "Workflow dispatch failed after provider batch import retry");
    });

    return reply.code(202).send(ingestionQueuedPayload(retryRun));
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
        },
        candidate: {
          select: {
            cleanedQuestionText: true,
            answerText: true,
            questionType: true,
            marks: true
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

    if (input.decision === "APPROVE") {
      const approvalConflict = reviewApprovalConflictPayload(reviewItem);
      if (approvalConflict) {
        return reply.code(409).send(approvalConflict);
      }
    }

    if (input.decision === "EDIT_AND_APPROVE") {
      const editApprovalConflict = reviewEditApprovalConflictPayload(reviewItem, input.reviewPayload);
      if (editApprovalConflict) {
        return reply.code(409).send(editApprovalConflict);
      }
    }

    try {
      await prisma.$transaction(async (tx) => {
        const updateResult = await tx.reviewItem.updateMany({
          where: mutableReviewItemWhere(reviewItem.id),
          data: reviewItemUpdateData(input)
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

  app.post("/api/internal/dispatch-workflows", async (request, reply) => {
    if (!isAuthorizedInternalRequest(request.headers, config)) {
      return reply.code(401).send({ error: "UNAUTHORIZED" });
    }

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

export function paperIngestionInputPayload(input: {
  sourcePaperId: string;
  uploadObjectId: string;
  objectKey: string;
  paperContext: Prisma.InputJsonValue | null;
  retryImportBatchJobId?: string | undefined;
  retryImportOperation?: "ocr" | "question_segmentation" | "question_solving" | undefined;
  config: Pick<
    ApiConfig,
    "TEMPORAL_TASK_QUEUE_PAPER_INGESTION" | "TEMPORAL_TASK_QUEUE_OCR" | "TEMPORAL_TASK_QUEUE_LLM"
  >;
}) {
  const payload = {
    sourcePaperId: input.sourcePaperId,
    uploadObjectId: input.uploadObjectId,
    objectKey: input.objectKey,
    paperContext: input.paperContext,
    taskQueues: {
      paperIngestion: input.config.TEMPORAL_TASK_QUEUE_PAPER_INGESTION,
      ocr: input.config.TEMPORAL_TASK_QUEUE_OCR,
      llm: input.config.TEMPORAL_TASK_QUEUE_LLM
    }
  };
  if (input.retryImportBatchJobId && input.retryImportOperation) {
    return {
      ...payload,
      retryImportBatchJobId: input.retryImportBatchJobId,
      retryImportOperation: input.retryImportOperation
    };
  }

  return payload;
}

export function paperContextPayloadFromSourcePaper(sourcePaper: {
  title: string | null;
  board: string | null;
  classLevel: string | null;
  subject: string | null;
  year: number | null;
  schoolName: string | null;
  examType: string | null;
  uploadedBy: string | null;
  metadata: Prisma.JsonValue;
}) {
  const payload = {
    title: sourcePaper.title ?? undefined,
    board: sourcePaper.board ?? undefined,
    classLevel: sourcePaper.classLevel ?? undefined,
    subject: sourcePaper.subject ?? undefined,
    year: sourcePaper.year ?? undefined,
    schoolName: sourcePaper.schoolName ?? undefined,
    examType: sourcePaper.examType ?? undefined,
    uploadedBy: sourcePaper.uploadedBy ?? undefined,
    metadata: sourcePaper.metadata === null ? undefined : sourcePaper.metadata
  };
  const entries = Object.entries(payload).filter(([, value]) => value !== undefined);
  return entries.length > 0 ? toInputJson(Object.fromEntries(entries)) : null;
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

function ingestionListQuery(query: unknown) {
  const record = query && typeof query === "object" && !Array.isArray(query) ? (query as Record<string, unknown>) : {};
  const limit = boundedQueryInteger(record.limit, 25, 1, 100);
  const offset = boundedQueryInteger(record.offset, 0, 0, 10_000);
  return {
    limit,
    offset,
    status: stringQuery(record.status),
    sourcePaperId: stringQuery(record.sourcePaperId),
    operation: stringQuery(record.operation)
  };
}

function ingestionListWhere(query: ReturnType<typeof ingestionListQuery>) {
  return {
    workflowType: "PAPER_INGESTION",
    ...(query.status && isWorkflowStatus(query.status) ? { status: query.status } : {}),
    ...(query.sourcePaperId ? { sourcePaperId: query.sourcePaperId } : {}),
    ...(query.operation
      ? {
          providerBatchJobs: {
            some: {
              operation: query.operation
            }
          }
        }
      : {})
  } satisfies Prisma.WorkflowRunWhereInput;
}

function totalEstimatedCostForRun(costs: Array<{ estimatedCostUsd: Prisma.Decimal | null }>) {
  let total = new Prisma.Decimal(0);
  let hasCost = false;
  for (const cost of costs) {
    if (cost.estimatedCostUsd === null) {
      continue;
    }
    total = total.add(cost.estimatedCostUsd);
    hasCost = true;
  }

  return hasCost ? total.toFixed(6) : null;
}

async function activeIngestionRunForSourcePaper(sourcePaperId: string) {
  return prisma.workflowRun.findFirst({
    where: {
      sourcePaperId,
      workflowType: "PAPER_INGESTION",
      status: { in: activeIngestionStatuses() }
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true
    }
  });
}

async function createRetryWorkflowRun(input: {
  sourcePaper: {
    id: string;
    uploadObjectId: string;
    uploadObject: {
      objectKey: string;
    };
    title: string | null;
    board: string | null;
    classLevel: string | null;
    subject: string | null;
    year: number | null;
    schoolName: string | null;
    examType: string | null;
    uploadedBy: string | null;
    metadata: Prisma.JsonValue;
  };
  config: ApiConfig;
  retryOfWorkflowRunId: string;
  retryImportBatchJobId?: string | undefined;
  retryImportOperation?: "ocr" | "question_segmentation" | "question_solving" | undefined;
}) {
  return prisma.$transaction(async (tx) => {
    await tx.sourcePaper.update({
      where: { id: input.sourcePaper.id },
      data: { status: "QUEUED" }
    });
    const run = await tx.workflowRun.create({
      data: {
        workflowType: "PAPER_INGESTION",
        entityId: input.sourcePaper.id,
        sourcePaperId: input.sourcePaper.id,
        retryOfWorkflowRunId: input.retryOfWorkflowRunId,
        status: "PENDING",
        currentStep: "store_file",
        inputPayload: paperIngestionInputPayload({
          sourcePaperId: input.sourcePaper.id,
          uploadObjectId: input.sourcePaper.uploadObjectId,
          objectKey: input.sourcePaper.uploadObject.objectKey,
          paperContext: paperContextPayloadFromSourcePaper(input.sourcePaper),
          retryImportBatchJobId: input.retryImportBatchJobId,
          retryImportOperation: input.retryImportOperation,
          config: input.config
        })
      }
    });
    await tx.workflowStartOutbox.create({ data: { workflowRunId: run.id } });
    await tx.workflowEvent.create({
      data: {
        workflowRunId: run.id,
        eventType: input.retryImportBatchJobId ? "BATCH_IMPORT_RETRY_QUEUED" : "WORKFLOW_RETRY_QUEUED",
        eventPayload: toInputJson({
          retryOfWorkflowRunId: input.retryOfWorkflowRunId,
          retryImportBatchJobId: input.retryImportBatchJobId,
          retryImportOperation: input.retryImportOperation
        })
      }
    });
    return run;
  });
}

function canRetryWorkflowRun(status: WorkflowStatus, force: boolean) {
  if (status === WorkflowStatus.FAILED || status === WorkflowStatus.CANCELLED) {
    return true;
  }

  return force && status === WorkflowStatus.COMPLETED;
}

function canRetryBatchImport(batchJob: {
  status: ProviderBatchJobStatus;
  outputFileId: string | null;
  operation: string;
}) {
  return (
    Boolean(batchJob.outputFileId) &&
    (batchJob.status === ProviderBatchJobStatus.IMPORT_FAILED ||
      batchJob.status === ProviderBatchJobStatus.SUCCEEDED ||
      batchJob.status === ProviderBatchJobStatus.IMPORTED) &&
    (batchJob.operation === "ocr" ||
      batchJob.operation === "question_segmentation" ||
      batchJob.operation === "question_solving")
  );
}

function providerBatchRetryOperation(operation: string) {
  if (operation === "ocr" || operation === "question_segmentation" || operation === "question_solving") {
    return operation;
  }

  throw new Error(`Unsupported provider batch operation: ${operation}`);
}

function retryForceFromBody(body: unknown) {
  return Boolean(body && typeof body === "object" && !Array.isArray(body) && (body as Record<string, unknown>).force === true);
}

function boundedQueryInteger(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : fallback;
  if (!Number.isInteger(parsed)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, parsed));
}

function stringQuery(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isWorkflowStatus(value: string): value is WorkflowStatus {
  return Object.values(WorkflowStatus).some((status) => status === value);
}

export function sourcePaperCanQueueIngestionWhere(id: string) {
  return {
    id,
    status: { in: ["UPLOADED", "COMPLETED", "FAILED", "CANCELLED"] }
  } satisfies Prisma.SourcePaperWhereInput;
}

export function sourcePaperQueuedForIngestionUpdate() {
  return {
    status: "QUEUED"
  } satisfies Prisma.SourcePaperUpdateManyMutationInput;
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

interface ReviewItemApprovalState {
  reasonCodes: Prisma.JsonValue;
  candidate: {
    cleanedQuestionText: string;
    answerText: string | null;
    questionType: string;
    marks: number | null;
  };
}

const reviewReasonCodeSet = new Set<string>(reviewReasonCodes);
const directApprovalBlockingReasonCodes = new Set<ReviewReasonCode>([
  "MISSING_REQUIRED_FIELD",
  "MISSING_QUESTION_TEXT",
  "MISSING_MARKS",
  "MCQ_OPTIONS_MISSING",
  "MCQ_CORRECT_ANSWER_MISSING",
  "DIAGRAM_ASSET_MISSING"
]);
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

export function reviewItemUpdateData(input: ReviewPatchInput, reviewedAt = new Date()) {
  const data: Prisma.ReviewItemUpdateManyMutationInput = {
    status: reviewStatusForDecision(input.decision),
    reviewedBy: input.reviewedBy ?? null,
    reviewNotes: input.reviewNotes ?? null,
    decision: input.decision,
    reviewedAt
  };

  if (Object.prototype.hasOwnProperty.call(input, "reviewPayload")) {
    data.reviewPayload = toNullableInputJson(input.reviewPayload);
  }

  return data;
}

export function reviewApprovalConflictPayload(reviewItem: ReviewItemApprovalState) {
  const missingFields = missingDirectApprovalFields(reviewItem.candidate);
  const blockingReasons = reviewReasonCodesFromJson(reviewItem.reasonCodes).filter((reason) =>
    directApprovalBlockingReasonCodes.has(reason)
  );

  if (missingFields.length === 0 && blockingReasons.length === 0) {
    return undefined;
  }

  return {
    error: "REVIEW_APPROVAL_REQUIRES_EDIT",
    message:
      "Direct approval can only ingest complete candidates as-is. Edit and approve, reject, mark duplicate, request more info, or mark this review item unprocessable.",
    missingFields,
    blockingReasons: [...new Set(blockingReasons)]
  };
}

export function reviewEditApprovalConflictPayload(reviewItem: Pick<ReviewItemApprovalState, "reasonCodes">, reviewPayload?: unknown) {
  const blockingReasons = reviewReasonCodesFromJson(reviewItem.reasonCodes).filter((reason) => {
    if (reason === "DIAGRAM_ASSET_MISSING") {
      return !reviewPayloadHasDiagramAsset(reviewPayload);
    }

    return false;
  });

  if (blockingReasons.length === 0) {
    return undefined;
  }

  return {
    error: "REVIEW_EDIT_APPROVAL_REQUIRES_STRUCTURAL_FIX",
    message:
      "Save edits cannot resolve this review item's structural requirements yet. Use another review decision or add structural editor support before approving.",
    blockingReasons: [...new Set(blockingReasons)]
  };
}

function reviewPayloadHasDiagramAsset(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("candidate" in value)) {
    return false;
  }

  const candidate = value.candidate;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || !("diagramAsset" in candidate)) {
    return false;
  }

  if (candidate.diagramAsset === null || candidate.diagramAsset === undefined) {
    return false;
  }

  return typeof candidate.diagramAsset === "string" ? candidate.diagramAsset.trim().length > 0 : true;
}

export function reviewReasonCodesFromJson(value: Prisma.JsonValue) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }

      if (item && typeof item === "object" && !Array.isArray(item) && "code" in item && typeof item.code === "string") {
        return item.code;
      }

      return undefined;
    })
    .filter((code): code is ReviewReasonCode => code !== undefined && reviewReasonCodeSet.has(code));
}

export function reviewSignalRunForItem(reviewItem: { workflowRun: { id: string; status: string } }) {
  return isActiveIngestionStatus(reviewItem.workflowRun.status) ? reviewItem.workflowRun : undefined;
}

export function isAuthorizedInternalRequest(
  headers: Record<string, string | string[] | undefined>,
  config: Pick<ApiConfig, "INTERNAL_API_TOKEN">
) {
  const token = firstHeaderValue(headers[INTERNAL_API_TOKEN_HEADER]);
  if (!token) {
    return false;
  }

  return constantTimeStringEqual(token, config.INTERNAL_API_TOKEN);
}

function firstHeaderValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function constantTimeStringEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function reviewItemAlreadyClosedPayload(reviewItem: ReviewItemMutationState) {
  return {
    error: "REVIEW_ITEM_ALREADY_CLOSED",
    status: reviewItem.status,
    appliedAt: reviewItem.appliedAt?.toISOString() ?? null
  };
}

function missingDirectApprovalFields(candidate: ReviewItemApprovalState["candidate"]) {
  const missingFields = [];

  if (candidate.cleanedQuestionText.trim().length === 0) {
    missingFields.push("cleanedQuestionText");
  }

  if (candidate.answerText === null || candidate.answerText.trim().length === 0) {
    missingFields.push("answerText");
  }

  if (candidate.questionType === "UNKNOWN") {
    missingFields.push("questionType");
  }

  if (candidate.marks === null) {
    missingFields.push("marks");
  }

  return missingFields;
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
