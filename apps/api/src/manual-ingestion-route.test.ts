import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiConfig } from "./config.js";

const mocks = vi.hoisted(() => {
  return {
    dispatchPendingWorkflowStarts: vi.fn(),
    prisma: {
      sourcePaper: {
        findUnique: vi.fn()
      },
      workflowRun: {
        findFirst: vi.fn()
      },
      $transaction: vi.fn()
    },
    tx: {
      sourcePaper: {
        updateMany: vi.fn()
      },
      workflowRun: {
        create: vi.fn(),
        findFirst: vi.fn()
      },
      workflowStartOutbox: {
        create: vi.fn()
      }
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
    Prisma: {
      JsonNull: null,
      PrismaClientKnownRequestError
    },
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

vi.mock("./outbox.js", () => ({
  dispatchPendingWorkflowStarts: mocks.dispatchPendingWorkflowStarts
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

const sourcePaper = {
  id: "source-paper-1",
  uploadObjectId: "upload-1",
  title: "Algebra Midterm",
  board: "CBSE",
  classLevel: "10",
  subject: "Mathematics",
  year: 2026,
  schoolName: "Apex Academy",
  examType: "Midterm",
  uploadedBy: "test@test.com",
  metadata: null,
  uploadObject: {
    objectKey: "source-papers/2026-07-02/paper.pdf"
  }
};

const { buildServer } = await import("./server.js");

describe("manual ingestion route", () => {
  beforeEach(() => {
    mocks.dispatchPendingWorkflowStarts.mockReset();
    mocks.dispatchPendingWorkflowStarts.mockResolvedValue(undefined);
    mocks.prisma.sourcePaper.findUnique.mockReset();
    mocks.prisma.workflowRun.findFirst.mockReset();
    mocks.prisma.$transaction.mockReset();
    mocks.tx.sourcePaper.updateMany.mockReset();
    mocks.tx.workflowRun.create.mockReset();
    mocks.tx.workflowRun.findFirst.mockReset();
    mocks.tx.workflowStartOutbox.create.mockReset();
    mocks.prisma.$transaction.mockImplementation(<T>(callback: (tx: typeof mocks.tx) => T | Promise<T>) => callback(mocks.tx));
  });

  it("creates a workflow run after claiming a terminal source paper", async () => {
    mocks.prisma.sourcePaper.findUnique.mockResolvedValue(sourcePaper);
    mocks.prisma.workflowRun.findFirst.mockResolvedValue(null);
    mocks.tx.sourcePaper.updateMany.mockResolvedValue({ count: 1 });
    mocks.tx.workflowRun.create.mockResolvedValue({
      id: "run-1",
      status: "PENDING"
    });
    mocks.tx.workflowStartOutbox.create.mockResolvedValue({});

    const app = await buildServer(apiConfig);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/papers/source-paper-1/ingestions"
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({
        ingestionRunId: "run-1",
        status: "QUEUED"
      });
      expect(mocks.tx.sourcePaper.updateMany).toHaveBeenCalledWith({
        where: {
          id: "source-paper-1",
          status: { in: ["UPLOADED", "COMPLETED", "FAILED", "CANCELLED"] }
        },
        data: { status: "QUEUED" }
      });
      expect(mocks.tx.workflowStartOutbox.create).toHaveBeenCalledWith({ data: { workflowRunId: "run-1" } });
      expect(mocks.dispatchPendingWorkflowStarts).toHaveBeenCalledWith(apiConfig);
    } finally {
      await app.close();
    }
  });

  it("returns the active run when another request already claimed the source paper", async () => {
    mocks.prisma.sourcePaper.findUnique.mockResolvedValue(sourcePaper);
    mocks.prisma.workflowRun.findFirst.mockResolvedValue(null);
    mocks.tx.sourcePaper.updateMany.mockResolvedValue({ count: 0 });
    mocks.tx.workflowRun.findFirst.mockResolvedValue({
      id: "run-active",
      status: "RUNNING"
    });

    const app = await buildServer(apiConfig);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/papers/source-paper-1/ingestions"
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({
        ingestionRunId: "run-active",
        status: "RUNNING"
      });
      expect(mocks.tx.workflowRun.create).not.toHaveBeenCalled();
      expect(mocks.tx.workflowStartOutbox.create).not.toHaveBeenCalled();
      expect(mocks.dispatchPendingWorkflowStarts).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
