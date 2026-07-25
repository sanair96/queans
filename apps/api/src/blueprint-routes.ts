import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import {
  blueprintDocumentStatuses,
  blueprintLanguageTagSchema,
  defaultBlueprintBoard,
  uploadInitSchema
} from "@queans/core";
import { Prisma, prisma } from "@queans/db";
import { loadR2ConfigFromEnv, R2ObjectStore, type StoredObjectHead } from "@queans/providers";

import { toInputJson } from "./json.js";

interface BlueprintIdParams {
  id: string;
}

interface BlueprintUploadIdParams {
  uploadId: string;
}

const blueprintMetadataSchema = z
  .object({
    title: z.string().trim().min(1).max(1_024).optional(),
    board: z.string().trim().min(1).max(512).optional(),
    subject: z.string().trim().min(1).max(512).optional(),
    academicLevel: z.string().trim().min(1).max(512).optional(),
    primaryLanguage: blueprintLanguageTagSchema.nullable().optional()
  })
  .strict();

const blueprintUploadInitSchema = uploadInitSchema.strict();

const blueprintUploadCompleteSchema = z
  .object({
    etag: z.string().optional(),
    byteSize: z.number().int().positive().optional(),
    metadata: blueprintMetadataSchema.optional()
  })
  .strict();

const blueprintMetadataPatchSchema = blueprintMetadataSchema
  .extend({
    title: z.string().trim().min(1).max(1_024).nullable().optional()
  })
  .superRefine((value, context) => {
    if (Object.keys(value).length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one editable Blueprint metadata field is required."
      });
    }
  });

const blueprintListQuerySchema = z.object({
  search: z.string().trim().min(1).max(512).optional(),
  board: z.string().trim().min(1).max(512).optional(),
  status: z.enum(blueprintDocumentStatuses).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25)
});

export function registerBlueprintRoutes(app: FastifyInstance) {
  app.post("/api/blueprints/uploads/init", async (request, reply) => {
    const input = blueprintUploadInitSchema.parse(request.body);
    const r2 = getR2ObjectStoreOrReply(reply);
    if (!r2) {
      return reply;
    }

    const objectKey = buildBlueprintObjectKey(input.fileName);
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

  app.post<{ Params: BlueprintUploadIdParams }>("/api/blueprints/uploads/:uploadId/complete", async (request, reply) => {
    const input = blueprintUploadCompleteSchema.parse(request.body);
    const r2 = getR2ObjectStoreOrReply(reply);
    if (!r2) {
      return reply;
    }
    // This is fetching the uploadObject from the DB to check if it exists.
    const upload = await prisma.uploadObject.findUnique({
      where: { id: request.params.uploadId },
      include: { blueprintDocument: { include: { workflowRuns: { orderBy: { createdAt: "desc" }, take: 1 } } } }
    });
    if (!upload) {
      return reply.code(404).send({ error: "UPLOAD_NOT_FOUND" });
    }
    if (upload.status === "COMPLETED" && upload.blueprintDocument) {
      return reply.send(blueprintUploadCompletionPayload(upload.blueprintDocument));
    }
    if (upload.status === "COMPLETED") {
      return reply.code(409).send({ error: "UPLOAD_ALREADY_COMPLETED" });
    }

    const head = await r2.headObject(upload.objectKey);
    const conflict = blueprintUploadCompletionConflict({
      head,
      reportedByteSize: input.byteSize,
      storedByteSize: upload.byteSize,
      storedMimeType: upload.mimeType
    });
    if (conflict) {
      return reply.code(409).send(conflict);
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        const completedUpload = await tx.uploadObject.update({
          where: { id: upload.id },
          data: {
            status: "COMPLETED",
            etag: input.etag ?? head.etag ?? null,
            completedAt: new Date()
          }
        });
        //Creates the actual blueprint record in DB
        const blueprintDocument = await tx.blueprintDocument.create({
          data: {
            uploadObjectId: completedUpload.id,
            originalFilename: completedUpload.fileName,
            title: input.metadata?.title ?? titleFromFilename(completedUpload.fileName),
            documentType: "Blueprint",
            board: input.metadata?.board ?? defaultBlueprintBoard,
            subject: input.metadata?.subject ?? null,
            academicLevel: input.metadata?.academicLevel ?? null,
            primaryLanguage: input.metadata?.primaryLanguage ?? null,
            primaryLanguageSource: input.metadata?.primaryLanguage ? "UPLOAD_METADATA" : "UNRESOLVED",
            status: "QUEUED"
          }
        });
        const workflowRunId = randomUUID();
        const workflowRun = await tx.workflowRun.create({
          data: {
            id: workflowRunId,
            workflowType: "BLUEPRINT_INGESTION",
            entityId: blueprintDocument.id,
            blueprintDocumentId: blueprintDocument.id,
            status: "PENDING",
            currentStep: "queued",
            inputPayload: toInputJson(
              blueprintIngestionInputPayload({
                workflowRunId,
                blueprintDocumentId: blueprintDocument.id
              })
            )
          }
        });
        await tx.workflowStartOutbox.create({ data: { workflowRunId: workflowRun.id } });
        await tx.workflowEvent.create({
          data: {
            workflowRunId: workflowRun.id,
            eventType: "BLUEPRINT_UPLOAD_COMPLETED",
            eventPayload: { blueprintDocumentId: blueprintDocument.id, workflowRunId: workflowRun.id }
          }
        });
        return { blueprintDocument, workflowRun };
      });

      return reply.code(202).send({
        blueprintDocumentId: result.blueprintDocument.id,
        workflowRunId: result.workflowRun.id,
        status: "QUEUED"
      });
    } catch (error) {
      if (isPrismaUniqueConstraintError(error)) {
        const existing = await findBlueprintUploadCompletionPayload(upload.id);
        if (existing) {
          return reply.send(existing);
        }
      }
      throw error;
    }
  });

  app.get("/api/blueprints", async (request) => {
    const query = blueprintListQuerySchema.parse(request.query);
    const cursor = query.cursor ? decodeBlueprintCursor(query.cursor) : undefined;
    const where: Prisma.BlueprintDocumentWhereInput = {
      ...(query.search
        ? {
          OR: [
            { title: { contains: query.search, mode: "insensitive" } },
            { originalFilename: { contains: query.search, mode: "insensitive" } },
            { board: { contains: query.search, mode: "insensitive" } },
            { subject: { contains: query.search, mode: "insensitive" } }
          ]
        }
        : {}),
      ...(query.board ? { board: query.board } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(cursor
        ? {
          AND: [
            {
              OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }]
            }
          ]
        }
        : {})
    };
    const documents = await prisma.blueprintDocument.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit + 1,
      select: blueprintListSelect
    });
    const hasNextPage = documents.length > query.limit;
    const page = hasNextPage ? documents.slice(0, query.limit) : documents;
    const lastDocument = page[page.length - 1];

    return {
      items: page,
      nextCursor: hasNextPage && lastDocument ? encodeBlueprintCursor(lastDocument) : null
    };
  });

  app.get<{ Params: BlueprintIdParams }>("/api/blueprints/:id", async (request, reply) => {
    const blueprintDocument = await prisma.blueprintDocument.findUnique({ where: { id: request.params.id } });
    if (!blueprintDocument) {
      return reply.code(404).send({ error: "BLUEPRINT_NOT_FOUND" });
    }
    return blueprintDetailPayload(blueprintDocument);
  });

  app.get<{ Params: BlueprintIdParams }>("/api/blueprints/:id/status", async (request, reply) => {
    const blueprintDocument = await prisma.blueprintDocument.findUnique({
      where: { id: request.params.id },
      select: { id: true, status: true, pageCount: true, extractionError: true, updatedAt: true }
    });
    if (!blueprintDocument) {
      return reply.code(404).send({ error: "BLUEPRINT_NOT_FOUND" });
    }
    const workflowRun = await prisma.workflowRun.findFirst({
      where: { blueprintDocumentId: blueprintDocument.id, workflowType: "BLUEPRINT_INGESTION" },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, currentStep: true, errorPayload: true, updatedAt: true }
    });
    return { ...blueprintDocument, workflowRun };
  });

  app.get<{ Params: BlueprintIdParams }>("/api/blueprints/:id/ocr-pages", async (request, reply) => {
    const blueprintDocument = await prisma.blueprintDocument.findUnique({
      where: { id: request.params.id },
      select: { id: true }
    });
    if (!blueprintDocument) {
      return reply.code(404).send({ error: "BLUEPRINT_NOT_FOUND" });
    }
    const pages = await prisma.blueprintOcrPage.findMany({
      where: { blueprintDocumentId: blueprintDocument.id },
      orderBy: { pageNumber: "asc" }
    });
    return { pages };
  });

  app.put<{ Params: BlueprintIdParams }>("/api/blueprints/:id/metadata", async (request, reply) => {
    const input = blueprintMetadataPatchSchema.parse(request.body);
    const data = blueprintMetadataUpdateData(input);
    const update = await prisma.blueprintDocument.updateMany({
      where: { id: request.params.id, status: { not: "APPROVED" } },
      data
    });
    if (update.count === 0) {
      const blueprintDocument = await prisma.blueprintDocument.findUnique({
        where: { id: request.params.id },
        select: { status: true }
      });
      if (!blueprintDocument) {
        return reply.code(404).send({ error: "BLUEPRINT_NOT_FOUND" });
      }
      return reply.code(409).send({ error: "BLUEPRINT_APPROVED_IMMUTABLE" });
    }

    const blueprintDocument = await prisma.blueprintDocument.findUnique({ where: { id: request.params.id } });
    if (!blueprintDocument) {
      return reply.code(404).send({ error: "BLUEPRINT_NOT_FOUND" });
    }
    return blueprintMetadataPayload(blueprintDocument);
  });
}

const blueprintListSelect = {
  id: true,
  title: true,
  originalFilename: true,
  board: true,
  subject: true,
  academicLevel: true,
  primaryLanguage: true,
  primaryLanguageSource: true,
  status: true,
  pageCount: true,
  approvedAt: true,
  createdAt: true,
  updatedAt: true
} satisfies Prisma.BlueprintDocumentSelect;

export function blueprintIngestionInputPayload(input: { workflowRunId: string; blueprintDocumentId: string }) {
  return {
    workflowRunId: input.workflowRunId,
    blueprintDocumentId: input.blueprintDocumentId
  };
}

export function blueprintUploadCompletionPayload(blueprintDocument: {
  id: string;
  workflowRuns: Array<{ id: string; status: string }>;
}) {
  const workflowRun = blueprintDocument.workflowRuns[0];
  return {
    blueprintDocumentId: blueprintDocument.id,
    workflowRunId: workflowRun?.id,
    status: workflowRun?.status === "PENDING" ? "QUEUED" : workflowRun?.status ?? "QUEUED"
  };
}

export function blueprintUploadCompletionConflict(input: {
  head: StoredObjectHead;
  reportedByteSize: number | undefined;
  storedByteSize: bigint | number;
  storedMimeType: string;
}) {
  if (input.reportedByteSize !== undefined && input.head.byteSize !== input.reportedByteSize) {
    return { error: "UPLOAD_SIZE_MISMATCH" };
  }
  if (input.head.byteSize !== Number(input.storedByteSize)) {
    return { error: "R2_OBJECT_SIZE_MISMATCH" };
  }
  const actualMimeType = normalizedMimeType(input.head.contentType);
  const expectedMimeType = normalizedMimeType(input.storedMimeType);
  if (actualMimeType !== expectedMimeType) {
    return { error: "R2_OBJECT_CONTENT_TYPE_MISMATCH", expectedMimeType, actualMimeType };
  }
  return undefined;
}

export function blueprintDetailPayload(blueprintDocument: {
  id: string;
  uploadObjectId: string;
  originalFilename: string;
  title: string | null;
  documentType: string | null;
  board: string;
  subject: string | null;
  academicLevel: string | null;
  detectedLanguages: Prisma.JsonValue | null;
  primaryLanguage: string | null;
  primaryLanguageSource: string;
  languageDetectionMetadata: Prisma.JsonValue | null;
  status: string;
  pageCount: number | null;
  draftRulesJson: Prisma.JsonValue | null;
  approvedRulesJson: Prisma.JsonValue | null;
  extractionMetadataJson: Prisma.JsonValue | null;
  confidenceSummaryJson: Prisma.JsonValue | null;
  extractionError: string | null;
  reviewVersion: number;
  approvedAt: Date | null;
  approvedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  const { draftRulesJson, approvedRulesJson, ...metadata } = blueprintDocument;
  return {
    ...metadata,
    draftRulesJson: blueprintDocument.status === "APPROVED" ? null : draftRulesJson,
    approvedRulesJson: blueprintDocument.status === "APPROVED" ? approvedRulesJson : null
  };
}

export function blueprintMetadataPayload(blueprintDocument: {
  id: string;
  title: string | null;
  board: string;
  subject: string | null;
  academicLevel: string | null;
  primaryLanguage: string | null;
  primaryLanguageSource: string;
  status: string;
  updatedAt: Date;
}) {
  return blueprintDocument;
}

function blueprintMetadataUpdateData(input: z.output<typeof blueprintMetadataPatchSchema>) {
  return {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.board !== undefined ? { board: input.board } : {}),
    ...(input.subject !== undefined ? { subject: input.subject } : {}),
    ...(input.academicLevel !== undefined ? { academicLevel: input.academicLevel } : {}),
    ...(input.primaryLanguage !== undefined
      ? {
        primaryLanguage: input.primaryLanguage,
        primaryLanguageSource: input.primaryLanguage === null ? "UNRESOLVED" : "USER_CONFIRMED"
      }
      : {})
  } satisfies Prisma.BlueprintDocumentUpdateManyMutationInput;
}

function buildBlueprintObjectKey(fileName: string) {
  const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const datePrefix = new Date().toISOString().slice(0, 10);
  return `blueprints/${datePrefix}/${randomUUID()}-${safeFileName}`;
}

function titleFromFilename(fileName: string) {
  const withoutExtension = fileName.replace(/\.[^.]+$/, "").trim();
  return withoutExtension || fileName;
}

function normalizedMimeType(value: string | undefined) {
  return value?.split(";")[0]?.trim().toLowerCase() || null;
}

function encodeBlueprintCursor(input: { id: string; createdAt: Date }) {
  return Buffer.from(JSON.stringify({ id: input.id, createdAt: input.createdAt.toISOString() })).toString("base64url");
}

function decodeBlueprintCursor(cursor: string) {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid cursor");
    }
    const value = parsed as { id?: unknown; createdAt?: unknown };
    if (typeof value.id !== "string" || typeof value.createdAt !== "string") {
      throw new Error("Invalid cursor");
    }
    const createdAt = new Date(value.createdAt);
    if (Number.isNaN(createdAt.getTime())) {
      throw new Error("Invalid cursor");
    }
    return { id: value.id, createdAt };
  } catch {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: ["cursor"],
        message: "Cursor is invalid."
      }
    ]);
  }
}

async function findBlueprintUploadCompletionPayload(uploadId: string) {
  const upload = await prisma.uploadObject.findUnique({
    where: { id: uploadId },
    include: { blueprintDocument: { include: { workflowRuns: { orderBy: { createdAt: "desc" }, take: 1 } } } }
  });
  return upload?.blueprintDocument ? blueprintUploadCompletionPayload(upload.blueprintDocument) : undefined;
}

function isPrismaUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
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
