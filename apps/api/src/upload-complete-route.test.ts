import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StoredObjectHead } from "@queans/providers";
import type { ApiConfig } from "./config.js";

type HeadObjectMock = (objectKey: string) => Promise<StoredObjectHead>;

const mocks = vi.hoisted(() => {
  return {
    headObject: vi.fn<HeadObjectMock>(),
    prisma: {
      uploadObject: {
        findUnique: vi.fn()
      },
      $transaction: vi.fn()
    }
  };
});

vi.mock("@queans/db", () => {
  class PrismaClientKnownRequestError extends Error {
    constructor(
      message: string,
      readonly options: { code: string; clientVersion: string }
    ) {
      super(message);
    }

    get code() {
      return this.options.code;
    }
  }

  return {
    Prisma: { PrismaClientKnownRequestError },
    prisma: mocks.prisma,
    ReviewStatus: {
      OPEN: "OPEN",
      ASSIGNED: "ASSIGNED",
      APPROVED: "APPROVED",
      EDITED: "EDITED",
      REJECTED: "REJECTED",
      SKIPPED: "SKIPPED"
    },
    WorkflowStatus: {
      PENDING: "PENDING",
      RUNNING: "RUNNING",
      WAITING_FOR_REVIEW: "WAITING_FOR_REVIEW"
    }
  };
});

vi.mock("@queans/providers", () => {
  class R2ObjectStore {
    headObject(objectKey: string) {
      return mocks.headObject(objectKey);
    }
  }

  return {
    loadR2ConfigFromEnv: vi.fn(() => ({
      accountId: "account-123",
      accessKeyId: "access-key",
      secretAccessKey: "secret-key",
      bucket: "question-papers",
      endpoint: "https://account-123.r2.cloudflarestorage.com",
      region: "auto",
      presignExpiresSeconds: 900
    })),
    R2ObjectStore
  };
});

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

describe("upload completion route", () => {
  beforeEach(() => {
    mocks.headObject.mockReset();
    mocks.prisma.uploadObject.findUnique.mockReset();
    mocks.prisma.$transaction.mockReset();
  });

  it("rejects R2 content-type mismatches before creating ingestion rows", async () => {
    mocks.prisma.uploadObject.findUnique.mockResolvedValue({
      id: "upload-1",
      objectKey: "source-papers/paper.pdf",
      mimeType: "application/pdf",
      byteSize: 1024n,
      status: "PENDING",
      sourcePaper: null
    });
    mocks.headObject.mockResolvedValue({
      byteSize: 1024,
      contentType: "image/png",
      etag: "etag-1"
    });

    const app = await buildServer(apiConfig);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/uploads/upload-1/complete",
        payload: {
          byteSize: 1024
        }
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: "R2_OBJECT_CONTENT_TYPE_MISMATCH",
        expectedMimeType: "application/pdf",
        actualMimeType: "image/png"
      });
      expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
