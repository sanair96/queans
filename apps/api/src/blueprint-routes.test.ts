import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "./config.js";

const mocks = vi.hoisted(() => ({
  createPresignedPut: vi.fn(),
  headObject: vi.fn(),
  prisma: {
    uploadObject: {
      create: vi.fn(),
      findUnique: vi.fn()
    },
    blueprintDocument: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn()
    },
    blueprintOcrPage: {
      findMany: vi.fn()
    },
    workflowRun: {
      findFirst: vi.fn()
    },
    $transaction: vi.fn()
  },
  tx: {
    uploadObject: { update: vi.fn() },
    blueprintDocument: { create: vi.fn() },
    workflowRun: { create: vi.fn() },
    workflowStartOutbox: { create: vi.fn() },
    workflowEvent: { create: vi.fn() }
  }
}));

vi.mock("@queans/db", () => {
  class PrismaClientKnownRequestError extends Error {
    constructor(message: string, readonly options: { code: string; clientVersion: string }) {
      super(message);
    }

    get code() {
      return this.options.code;
    }
  }

  return {
    Prisma: { JsonNull: null, PrismaClientKnownRequestError },
    prisma: mocks.prisma,
    ReviewStatus: {},
    WorkflowStatus: {}
  };
});

vi.mock("@queans/providers", () => {
  class R2ObjectStore {
    createPresignedPut(input: unknown) {
      return mocks.createPresignedPut(input) as unknown;
    }

    headObject(objectKey: string) {
      return mocks.headObject(objectKey) as unknown;
    }
  }

  return {
    loadR2ConfigFromEnv: vi.fn(() => ({
      accountId: "account-123",
      accessKeyId: "access-key",
      secretAccessKey: "secret-key",
      bucket: "blueprints",
      endpoint: "https://account-123.r2.cloudflarestorage.com",
      region: "auto",
      presignExpiresSeconds: 900
    })),
    maxR2PresignExpiresSeconds: 900,
    R2ObjectStore
  };
});

vi.mock("./outbox.js", () => ({
  dispatchPendingWorkflowStarts: vi.fn()
}));

vi.mock("./readiness.js", () => ({
  checkReadiness: vi.fn()
}));

vi.mock("./temporal.js", () => ({
  signalHumanReviewCompleted: vi.fn()
}));

const apiConfig: ApiConfig = {
  NODE_ENV: "test",
  API_PORT: 4000,
  APP_URL: "http://localhost:3000",
  INTERNAL_API_TOKEN: "test-internal-token",
  MISTRAL_EXECUTION_MODE: "sync",
  TEMPORAL_ADDRESS: "localhost:7233",
  TEMPORAL_NAMESPACE: "default",
  TEMPORAL_TASK_QUEUE_PAPER_INGESTION: "paper-ingestion",
  TEMPORAL_TASK_QUEUE_OCR: "paper-ocr",
  TEMPORAL_TASK_QUEUE_LLM: "paper-llm-extraction"
};

const { buildServer } = await import("./server.js");
const {
  blueprintDetailPayload,
  blueprintIngestionInputPayload,
  blueprintUploadCompletionConflict,
  blueprintUploadCompletionPayload
} = await import("./blueprint-routes.js");

describe("Blueprint API routes", () => {
  beforeEach(() => {
    mocks.createPresignedPut.mockReset();
    mocks.headObject.mockReset();
    mocks.prisma.uploadObject.create.mockReset();
    mocks.prisma.uploadObject.findUnique.mockReset();
    mocks.prisma.blueprintDocument.findUnique.mockReset();
    mocks.prisma.blueprintDocument.findMany.mockReset();
    mocks.prisma.blueprintDocument.updateMany.mockReset();
    mocks.prisma.blueprintOcrPage.findMany.mockReset();
    mocks.prisma.workflowRun.findFirst.mockReset();
    mocks.prisma.$transaction.mockReset();
    mocks.tx.uploadObject.update.mockReset();
    mocks.tx.blueprintDocument.create.mockReset();
    mocks.tx.workflowRun.create.mockReset();
    mocks.tx.workflowStartOutbox.create.mockReset();
    mocks.tx.workflowEvent.create.mockReset();
    mocks.prisma.$transaction.mockImplementation(<T>(callback: (tx: typeof mocks.tx) => T | Promise<T>) => callback(mocks.tx));
  });

  it("initializes a Blueprint upload with the existing direct-to-R2 policy", async () => {
    mocks.createPresignedPut.mockResolvedValue({
      url: "https://r2.example/upload",
      expiresAt: new Date("2026-07-25T10:00:00.000Z")
    });
    mocks.prisma.uploadObject.create.mockResolvedValue({ id: "upload-1" });
    const app = await buildServer(apiConfig);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/blueprints/uploads/init",
        payload: { fileName: "class-x.pdf", mimeType: "application/pdf", byteSize: 1024 }
      });

      expect(response.statusCode).toBe(201);
      expect(response.body).toContain('"uploadId":"upload-1"');
      expect(response.body).toMatch(/"objectKey":"blueprints\/\d{4}-\d{2}-\d{2}\//);
      expect(response.body).toContain('"uploadUrl":"https://r2.example/upload"');
      expect(response.body).toContain('"expiresAt":"2026-07-25T10:00:00.000Z"');
    } finally {
      await app.close();
    }
  });

  it("does not silently discard preliminary metadata that cannot yet be persisted", async () => {
    const app = await buildServer(apiConfig);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/blueprints/uploads/init",
        payload: {
          fileName: "class-x.pdf",
          mimeType: "application/pdf",
          byteSize: 1024,
          metadata: { board: "CBSE" }
        }
      });

      expect(response.statusCode).toBe(400);
      expect(response.body).toContain('"error":"VALIDATION_ERROR"');
    } finally {
      await app.close();
    }
  });

  it("completes a verified upload idempotently and queues an identifier-only Blueprint run", async () => {
    mocks.prisma.uploadObject.findUnique.mockResolvedValue({
      id: "upload-1",
      objectKey: "blueprints/2026-07-25/class-x.pdf",
      fileName: "class-x.pdf",
      mimeType: "application/pdf",
      byteSize: 1024n,
      status: "PENDING",
      blueprintDocument: null
    });
    mocks.headObject.mockResolvedValue({ byteSize: 1024, contentType: "application/pdf", etag: "etag-1" });
    mocks.tx.uploadObject.update.mockResolvedValue({ id: "upload-1", fileName: "class-x.pdf" });
    mocks.tx.blueprintDocument.create.mockResolvedValue({ id: "blueprint-1" });
    mocks.tx.workflowRun.create.mockImplementation((input: unknown) => {
      const data = (input as { data: { id: string } }).data;
      return Promise.resolve({ id: data.id, status: "PENDING" });
    });
    const app = await buildServer(apiConfig);

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/blueprints/uploads/upload-1/complete",
        payload: { byteSize: 1024, metadata: { board: "CBSE", primaryLanguage: "hi" } }
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({ blueprintDocumentId: "blueprint-1", status: "QUEUED" });
      const blueprintCreateCall: unknown = mocks.tx.blueprintDocument.create.mock.calls[0]?.[0];
      expect(blueprintCreateCall).toMatchObject({
        data: {
          board: "CBSE",
          primaryLanguage: "hi",
          primaryLanguageSource: "UPLOAD_METADATA",
          status: "QUEUED"
        }
      });
      const workflowCreate = mocks.tx.workflowRun.create.mock.calls[0]?.[0] as { data: { inputPayload: unknown } };
      expect(workflowCreate.data.inputPayload).toEqual(
        expect.objectContaining({ blueprintDocumentId: "blueprint-1" })
      );
      expect(Object.keys(workflowCreate.data.inputPayload as object).sort()).toEqual(["blueprintDocumentId", "workflowRunId"]);
    } finally {
      await app.close();
    }
  });

  it("returns only the approved rules after approval", () => {
    const payload = blueprintDetailPayload({
      id: "blueprint-1",
      uploadObjectId: "upload-1",
      originalFilename: "class-x.pdf",
      title: "Class X",
      documentType: "Blueprint",
      board: "CBSE",
      subject: null,
      academicLevel: null,
      detectedLanguages: null,
      primaryLanguage: "hi",
      primaryLanguageSource: "USER_CONFIRMED",
      languageDetectionMetadata: null,
      status: "APPROVED",
      pageCount: 2,
      draftRulesJson: { changed: true },
      approvedRulesJson: { approved: true },
      extractionMetadataJson: null,
      confidenceSummaryJson: null,
      extractionError: null,
      reviewVersion: 1,
      approvedAt: null,
      approvedBy: null,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    expect(payload.draftRulesJson).toBeNull();
    expect(payload.approvedRulesJson).toEqual({ approved: true });
  });

  it("rejects metadata changes after approval", async () => {
    mocks.prisma.blueprintDocument.updateMany.mockResolvedValue({ count: 0 });
    mocks.prisma.blueprintDocument.findUnique.mockResolvedValue({ status: "APPROVED" });
    const app = await buildServer(apiConfig);

    try {
      const response = await app.inject({
        method: "PUT",
        url: "/api/blueprints/blueprint-1/metadata",
        payload: { board: "ICSE" }
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: "BLUEPRINT_APPROVED_IMMUTABLE" });
    } finally {
      await app.close();
    }
  });

  it("lists Blueprint metadata with board/status filters and a stable next cursor", async () => {
    mocks.prisma.blueprintDocument.findMany.mockResolvedValue([
      {
        id: "blueprint-2",
        title: "Mathematics",
        originalFilename: "math.pdf",
        board: "CBSE",
        subject: "Mathematics",
        academicLevel: "10",
        primaryLanguage: "en",
        primaryLanguageSource: "INFERRED",
        status: "QUEUED",
        pageCount: null,
        approvedAt: null,
        createdAt: new Date("2026-07-25T10:00:00.000Z"),
        updatedAt: new Date("2026-07-25T10:00:00.000Z")
      },
      {
        id: "blueprint-1",
        title: "Mathematics older",
        originalFilename: "math-old.pdf",
        board: "CBSE",
        subject: "Mathematics",
        academicLevel: "10",
        primaryLanguage: "en",
        primaryLanguageSource: "INFERRED",
        status: "QUEUED",
        pageCount: null,
        approvedAt: null,
        createdAt: new Date("2026-07-24T10:00:00.000Z"),
        updatedAt: new Date("2026-07-24T10:00:00.000Z")
      }
    ]);
    const app = await buildServer(apiConfig);

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/blueprints?search=math&board=CBSE&status=QUEUED&limit=1"
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('"id":"blueprint-2"');
      expect(response.body).toContain('"nextCursor":"');
      const listCall: unknown = mocks.prisma.blueprintDocument.findMany.mock.calls[0]?.[0];
      expect(listCall).toMatchObject({
        take: 2,
        where: { board: "CBSE", status: "QUEUED" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }]
      });
    } finally {
      await app.close();
    }
  });

  it("returns OCR pages in page-number order without exposing storage credentials", async () => {
    mocks.prisma.blueprintDocument.findUnique.mockResolvedValue({ id: "blueprint-1" });
    mocks.prisma.blueprintOcrPage.findMany.mockResolvedValue([
      { pageNumber: 1, markdownText: "# Rules", plainText: "Rules", detectedLanguages: ["en"] }
    ]);
    const app = await buildServer(apiConfig);

    try {
      const response = await app.inject({ method: "GET", url: "/api/blueprints/blueprint-1/ocr-pages" });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('"pageNumber":1');
      const pageCall: unknown = mocks.prisma.blueprintOcrPage.findMany.mock.calls[0]?.[0];
      expect(pageCall).toEqual({ where: { blueprintDocumentId: "blueprint-1" }, orderBy: { pageNumber: "asc" } });
    } finally {
      await app.close();
    }
  });
});

describe("Blueprint API helpers", () => {
  it("keeps workflow payloads identifier-only and completed responses stable", () => {
    expect(blueprintIngestionInputPayload({ workflowRunId: "run-1", blueprintDocumentId: "blueprint-1" })).toEqual({
      workflowRunId: "run-1",
      blueprintDocumentId: "blueprint-1"
    });
    expect(blueprintUploadCompletionPayload({ id: "blueprint-1", workflowRuns: [{ id: "run-1", status: "PENDING" }] })).toEqual({
      blueprintDocumentId: "blueprint-1",
      workflowRunId: "run-1",
      status: "QUEUED"
    });
  });

  it("rejects a completed object whose MIME type differs from the initialized upload", () => {
    expect(
      blueprintUploadCompletionConflict({
        head: { byteSize: 1024, contentType: "image/png" },
        reportedByteSize: 1024,
        storedByteSize: 1024n,
        storedMimeType: "application/pdf"
      })
    ).toEqual({
      error: "R2_OBJECT_CONTENT_TYPE_MISMATCH",
      expectedMimeType: "application/pdf",
      actualMimeType: "image/png"
    });
  });
});
