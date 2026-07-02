import { prisma, Prisma, ProviderBatchJobStatus } from "@queans/db";
import type { MistralBatchJob } from "@queans/providers";

import { toInputJson, toNullableInputJson } from "../json.js";

export type BatchOperation = "ocr" | "question_segmentation" | "question_solving";

export class ProviderBatchNotCompleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderBatchNotCompleteError";
  }
}

export function providerBatchJobCreateData(input: {
  workflowRunId: string;
  sourcePaperId: string;
  operation: BatchOperation;
  endpoint: string;
  model: string;
  inputFileId: string;
  batchJob: MistralBatchJob;
  retryOfBatchJobId?: string | undefined;
}) {
  return {
    workflowRunId: input.workflowRunId,
    sourcePaperId: input.sourcePaperId,
    retryOfBatchJobId: input.retryOfBatchJobId ?? null,
    provider: "MISTRAL",
    operation: input.operation,
    endpoint: input.endpoint,
    model: input.model,
    status: mapMistralBatchStatus(input.batchJob.status),
    inputFileId: input.inputFileId,
    providerJobId: input.batchJob.id,
    outputFileId: input.batchJob.outputFile ?? null,
    errorFileId: input.batchJob.errorFile ?? null,
    totalRequests: input.batchJob.totalRequests ?? null,
    succeededRequests: input.batchJob.succeededRequests ?? null,
    failedRequests: input.batchJob.failedRequests ?? null,
    submittedAt: new Date(),
    completedAt: completedAtForStatus(input.batchJob.status),
    lastPolledAt: new Date(),
    rawJson: toInputJson(input.batchJob.rawJson)
  } satisfies Prisma.ProviderBatchJobUncheckedCreateInput;
}

export async function createProviderBatchJob(input: Parameters<typeof providerBatchJobCreateData>[0]) {
  return prisma.providerBatchJob.create({
    data: providerBatchJobCreateData(input)
  });
}

export async function ensureRetryImportProviderBatchJob(input: {
  workflowRunId: string;
  sourcePaperId: string;
  retryOfBatchJobId: string;
  operation: BatchOperation;
}) {
  const existing = await prisma.providerBatchJob.findFirst({
    where: {
      workflowRunId: input.workflowRunId,
      sourcePaperId: input.sourcePaperId,
      operation: input.operation,
      retryOfBatchJobId: input.retryOfBatchJobId
    }
  });
  if (existing) {
    return existing;
  }

  const original = await prisma.providerBatchJob.findUnique({
    where: { id: input.retryOfBatchJobId }
  });
  if (!original?.providerJobId || !original.outputFileId) {
    throw new Error(`Provider batch job ${input.retryOfBatchJobId} cannot be imported in a retry attempt`);
  }
  if (original.operation !== input.operation) {
    throw new Error(
      `Provider batch job ${input.retryOfBatchJobId} is ${original.operation}, not ${input.operation}`
    );
  }

  return prisma.providerBatchJob.create({
    data: {
      workflowRunId: input.workflowRunId,
      sourcePaperId: input.sourcePaperId,
      retryOfBatchJobId: original.id,
      provider: original.provider,
      operation: original.operation,
      endpoint: original.endpoint,
      model: original.model,
      status: original.status,
      inputFileId: original.inputFileId,
      providerJobId: original.providerJobId,
      outputFileId: original.outputFileId,
      errorFileId: original.errorFileId,
      totalRequests: original.totalRequests,
      succeededRequests: original.succeededRequests,
      failedRequests: original.failedRequests,
      submittedAt: original.submittedAt,
      completedAt: original.completedAt,
      lastPolledAt: original.lastPolledAt,
      rawJson: toNullableInputJson(original.rawJson)
    }
  });
}

export async function updateProviderBatchJobFromProvider(input: {
  id: string;
  batchJob: MistralBatchJob;
}) {
  return prisma.providerBatchJob.update({
    where: { id: input.id },
    data: {
      status: mapMistralBatchStatus(input.batchJob.status),
      outputFileId: input.batchJob.outputFile ?? null,
      errorFileId: input.batchJob.errorFile ?? null,
      totalRequests: input.batchJob.totalRequests ?? null,
      succeededRequests: input.batchJob.succeededRequests ?? null,
      failedRequests: input.batchJob.failedRequests ?? null,
      completedAt: completedAtForStatus(input.batchJob.status),
      lastPolledAt: new Date(),
      rawJson: toInputJson(input.batchJob.rawJson)
    }
  });
}

export async function markProviderBatchImporting(id: string) {
  return prisma.providerBatchJob.update({
    where: { id },
    data: {
      status: ProviderBatchJobStatus.IMPORTING,
      importError: Prisma.JsonNull
    }
  });
}

export async function markProviderBatchImported(input: { id: string; output: unknown }) {
  return prisma.providerBatchJob.update({
    where: { id: input.id },
    data: {
      status: ProviderBatchJobStatus.IMPORTED,
      importedAt: new Date(),
      importError: Prisma.JsonNull,
      rawJson: toInputJson(input.output)
    }
  });
}

export async function markProviderBatchImportFailed(input: { id: string; error: unknown }) {
  return prisma.providerBatchJob.update({
    where: { id: input.id },
    data: {
      status: ProviderBatchJobStatus.IMPORT_FAILED,
      importError: toNullableInputJson(serializeImportError(input.error))
    }
  });
}

export function mapMistralBatchStatus(status: string) {
  const normalized = status.trim().toUpperCase();
  switch (normalized) {
    case "QUEUED":
    case "PENDING":
    case "VALIDATING":
    case "SUBMITTED":
      return ProviderBatchJobStatus.SUBMITTED;
    case "RUNNING":
    case "IN_PROGRESS":
      return ProviderBatchJobStatus.RUNNING;
    case "SUCCESS":
    case "SUCCEEDED":
    case "COMPLETED":
      return ProviderBatchJobStatus.SUCCEEDED;
    case "CANCELLED":
    case "CANCELED":
      return ProviderBatchJobStatus.CANCELLED;
    case "FAILED":
    case "ERROR":
      return ProviderBatchJobStatus.FAILED;
    default:
      return ProviderBatchJobStatus.RUNNING;
  }
}

export function assertBatchSucceeded(batchJob: MistralBatchJob) {
  const status = mapMistralBatchStatus(batchJob.status);
  if (status === ProviderBatchJobStatus.SUCCEEDED) {
    if (!batchJob.outputFile) {
      throw new Error(`Mistral batch job ${batchJob.id} succeeded without an output file`);
    }
    return;
  }

  if (status === ProviderBatchJobStatus.FAILED || status === ProviderBatchJobStatus.CANCELLED) {
    throw new Error(`Mistral batch job ${batchJob.id} ended with status ${batchJob.status}`);
  }

  throw new ProviderBatchNotCompleteError(`Mistral batch job ${batchJob.id} is not complete yet: ${batchJob.status}`);
}

function completedAtForStatus(status: string) {
  const mapped = mapMistralBatchStatus(status);
  return mapped === ProviderBatchJobStatus.SUCCEEDED ||
    mapped === ProviderBatchJobStatus.FAILED ||
    mapped === ProviderBatchJobStatus.CANCELLED
    ? new Date()
    : null;
}

function serializeImportError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }

  return {
    message: "Unknown import error",
    value: error
  };
}
