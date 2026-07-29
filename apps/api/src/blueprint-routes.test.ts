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
  TEMPORAL_TASK_QUEUE_BLUEPRINT_INGESTION: "blueprint-ingestion",
  TEMPORAL_TASK_QUEUE_OCR: "paper-ocr",
  TEMPORAL_TASK_QUEUE_LLM: "paper-llm-extraction"
};

const { buildServer } = await import("./server.js");
const {
  blueprintDetailPayload,
  blueprintIngestionInputPayload,
  blueprintRetryMode,
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
      expect(Object.keys(workflowCreate.data.inputPayload as object).sort()).toEqual(["blueprintDocumentId", "mode", "workflowRunId"]);
    } finally {
      await app.close();
    }
  });

  it("returns editable rules for a ready Blueprint", () => {
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
      status: "READY",
      pageCount: 2,
      draftRulesJson: { changed: true },
      extractionMetadataJson: null,
      confidenceSummaryJson: null,
      extractionError: null,
      reviewVersion: 1,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    expect(payload.draftRulesJson).toEqual({ changed: true });
  });

  it("allows metadata changes after rules are saved", async () => {
    mocks.prisma.blueprintDocument.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.blueprintDocument.findUnique.mockResolvedValue({
      id: "blueprint-1",
      title: "Class X",
      board: "ICSE",
      subject: null,
      academicLevel: null,
      primaryLanguage: "hi",
      primaryLanguageSource: "USER_CONFIRMED",
      status: "READY",
      updatedAt: new Date()
    });
    const app = await buildServer(apiConfig);

    try {
      const response = await app.inject({
        method: "PUT",
        url: "/api/blueprints/blueprint-1/metadata",
        payload: { board: "ICSE" }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ board: "ICSE", status: "READY" });
    } finally {
      await app.close();
    }
  });

  it("confirms a detected primary language and keeps language analysis in sync", async () => {
    mocks.prisma.blueprintDocument.findUnique
      .mockResolvedValueOnce({
        status: "NEEDS_REVIEW",
        languageDetectionMetadata: {
          detectedLanguages: [
            { tag: "en", confidence: 0.98, pageNumbers: [1] },
            { tag: "hi", confidence: 0.95, pageNumbers: [2] }
          ],
          primaryLanguage: { tag: "en", source: "INFERRED", confidence: 0.7, requiresConfirmation: true },
          mixedLanguagePageNumbers: [],
          multilingualRelationship: "DUPLICATE_TRANSLATIONS"
        }
      })
      .mockResolvedValueOnce({
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
        status: "NEEDS_REVIEW",
        pageCount: 2,
        draftRulesJson: null,
        extractionMetadataJson: null,
        confidenceSummaryJson: null,
        extractionError: "A primary language must be selected or confirmed before Blueprint rules can be extracted.",
        reviewVersion: 0,
        createdAt: new Date(),
        updatedAt: new Date()
      });
    mocks.prisma.blueprintDocument.updateMany.mockResolvedValue({ count: 1 });
    const app = await buildServer(apiConfig);

    try {
      const response = await app.inject({
        method: "PUT",
        url: "/api/blueprints/blueprint-1/primary-language",
        payload: { primaryLanguage: "hi" }
      });

      expect(response.statusCode).toBe(200);
      const updateCall: unknown = mocks.prisma.blueprintDocument.updateMany.mock.calls[0]?.[0];
      expect(updateCall).toMatchObject({
        where: { id: "blueprint-1" },
        data: {
          primaryLanguage: "hi",
          primaryLanguageSource: "USER_CONFIRMED",
          languageDetectionMetadata: {
            primaryLanguage: { tag: "hi", source: "USER_CONFIRMED", confidence: 1, requiresConfirmation: false }
          }
        }
      });
    } finally {
      await app.close();
    }
  });

  it("does not allow confirmation of a language absent from the detected-language evidence", async () => {
    mocks.prisma.blueprintDocument.findUnique.mockResolvedValue({
      status: "NEEDS_REVIEW",
      languageDetectionMetadata: {
        detectedLanguages: [{ tag: "en", confidence: 0.98, pageNumbers: [1] }],
        primaryLanguage: { tag: null, source: "UNRESOLVED", confidence: null, requiresConfirmation: true },
        mixedLanguagePageNumbers: [],
        multilingualRelationship: "MIXED_OR_UNCERTAIN"
      }
    });
    const app = await buildServer(apiConfig);

    try {
      const response = await app.inject({
        method: "PUT",
        url: "/api/blueprints/blueprint-1/primary-language",
        payload: { primaryLanguage: "hi" }
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: "BLUEPRINT_PRIMARY_LANGUAGE_NOT_DETECTED" });
      expect(mocks.prisma.blueprintDocument.updateMany).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("saves an editable generic rules document with its current review version", async () => {
    mocks.prisma.blueprintDocument.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.blueprintDocument.findUnique.mockResolvedValue({
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
      status: "READY",
      pageCount: 2,
      draftRulesJson: { sections: [{ label: "खंड अ", marks: 10 }] },
      extractionMetadataJson: null,
      confidenceSummaryJson: null,
      extractionError: null,
      reviewVersion: 4,
      createdAt: new Date(),
      updatedAt: new Date()
    });
    const app = await buildServer(apiConfig);

    try {
      const response = await app.inject({
        method: "PUT",
        url: "/api/blueprints/blueprint-1/rules",
        payload: { rules: { sections: [{ label: "खंड अ", marks: 10 }] }, reviewVersion: 3 }
      });

      expect(response.statusCode).toBe(200);
      const updateCall: unknown = mocks.prisma.blueprintDocument.updateMany.mock.calls[0]?.[0];
      expect(updateCall).toMatchObject({
        where: { id: "blueprint-1", status: "READY", reviewVersion: 3 },
        data: { reviewVersion: { increment: 1 }, extractionError: null }
      });
      expect(response.json()).toMatchObject({ reviewVersion: 4, draftRulesJson: { sections: [{ marks: 10 }] } });
    } finally {
      await app.close();
    }
  });

  it("reports a version conflict without overwriting newer Blueprint rules", async () => {
    mocks.prisma.blueprintDocument.updateMany.mockResolvedValue({ count: 0 });
    mocks.prisma.blueprintDocument.findUnique.mockResolvedValue({ status: "READY", reviewVersion: 7 });
    const app = await buildServer(apiConfig);

    try {
      const response = await app.inject({
        method: "PUT",
        url: "/api/blueprints/blueprint-1/rules",
        payload: { rules: "new rules", reviewVersion: 6 }
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: "BLUEPRINT_REVIEW_VERSION_CONFLICT", currentReviewVersion: 7 });
    } finally {
      await app.close();
    }
  });

  it("exposes saved Blueprint rules without coupling them to paper ingestion", async () => {
    mocks.prisma.blueprintDocument.findMany.mockResolvedValue([
      {
        id: "blueprint-1",
        title: "Class X",
        originalFilename: "class-x.pdf",
        board: "CBSE",
        subject: "Mathematics",
        academicLevel: "10",
        primaryLanguage: "hi",
        primaryLanguageSource: "USER_CONFIRMED",
        status: "READY",
        pageCount: 2,
        createdAt: new Date(),
        updatedAt: new Date()
      }
    ]);
    mocks.prisma.blueprintDocument.findUnique.mockResolvedValue({
      id: "blueprint-1",
      title: "Class X",
      board: "CBSE",
      subject: "Mathematics",
      academicLevel: "10",
      primaryLanguage: "hi",
      status: "READY",
      draftRulesJson: { duration: "3 hours" },
      reviewVersion: 2,
      updatedAt: new Date()
    });
    const app = await buildServer(apiConfig);

    try {
      const listResponse = await app.inject({ method: "GET", url: "/api/blueprints/saved" });
      const rulesResponse = await app.inject({ method: "GET", url: "/api/blueprints/blueprint-1/rules" });

      expect(listResponse.statusCode).toBe(200);
      expect(listResponse.json()).toMatchObject({ items: [{ id: "blueprint-1", status: "READY" }] });
      expect(rulesResponse.statusCode).toBe(200);
      expect(rulesResponse.json()).toMatchObject({ id: "blueprint-1", rules: { duration: "3 hours" }, reviewVersion: 2 });
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
    expect(blueprintIngestionInputPayload({ workflowRunId: "run-1", blueprintDocumentId: "blueprint-1", mode: "FULL" })).toEqual({
      workflowRunId: "run-1",
      blueprintDocumentId: "blueprint-1",
      mode: "FULL"
    });
    expect(blueprintUploadCompletionPayload({ id: "blueprint-1", workflowRuns: [{ id: "run-1", status: "PENDING" }] })).toEqual({
      blueprintDocumentId: "blueprint-1",
      workflowRunId: "run-1",
      status: "QUEUED"
    });
  });

  it("resumes only when all OCR pages were persisted", () => {
    expect(blueprintRetryMode({ pageCount: 2, ocrPageCount: 2 })).toBe("RESUME_FROM_OCR");
    expect(blueprintRetryMode({ pageCount: 2, ocrPageCount: 1 })).toBe("FULL");
    expect(blueprintRetryMode({ pageCount: null, ocrPageCount: 1 })).toBe("FULL");
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

  it("distinguishes client-reported and object-store size mismatches", () => {
    expect(
      blueprintUploadCompletionConflict({
        head: { byteSize: 1024, contentType: "application/pdf" },
        reportedByteSize: 512,
        storedByteSize: 1024n,
        storedMimeType: "application/pdf"
      })
    ).toEqual({ error: "UPLOAD_SIZE_MISMATCH" });
    expect(
      blueprintUploadCompletionConflict({
        head: { byteSize: 512, contentType: "application/pdf" },
        reportedByteSize: 512,
        storedByteSize: 1024n,
        storedMimeType: "application/pdf"
      })
    ).toEqual({ error: "R2_OBJECT_SIZE_MISMATCH" });
  });
});
