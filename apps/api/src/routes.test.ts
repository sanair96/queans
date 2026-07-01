import { describe, expect, it } from "vitest";

import { Prisma } from "@queans/db";

import {
  ingestionQueuedPayload,
  isActiveIngestionStatus,
  isPrismaUniqueConstraintError,
  uploadCompletionPayload
} from "./routes.js";

describe("uploadCompletionPayload", () => {
  it("returns the latest ingestion run for an already completed upload", () => {
    expect(
      uploadCompletionPayload({
        id: "source-paper-1",
        workflowRuns: [
          { id: "run-new", status: "RUNNING" },
          { id: "run-old", status: "FAILED" }
        ]
      })
    ).toEqual({
      sourcePaperId: "source-paper-1",
      ingestionRunId: "run-new",
      status: "RUNNING"
    });
  });

  it("keeps a completed upload response stable when the workflow run is not visible yet", () => {
    expect(
      uploadCompletionPayload({
        id: "source-paper-1",
        workflowRuns: []
      })
    ).toEqual({
      sourcePaperId: "source-paper-1",
      ingestionRunId: undefined,
      status: "PENDING"
    });
  });
});

describe("isPrismaUniqueConstraintError", () => {
  it("detects Prisma unique constraint errors", () => {
    expect(
      isPrismaUniqueConstraintError(
        new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: "test"
        })
      )
    ).toBe(true);
  });

  it("does not treat other Prisma errors as unique constraint races", () => {
    expect(
      isPrismaUniqueConstraintError(
        new Prisma.PrismaClientKnownRequestError("Missing row", {
          code: "P2025",
          clientVersion: "test"
        })
      )
    ).toBe(false);
  });
});

describe("isActiveIngestionStatus", () => {
  it("treats unfinished ingestion statuses as active", () => {
    expect(isActiveIngestionStatus("PENDING")).toBe(true);
    expect(isActiveIngestionStatus("RUNNING")).toBe(true);
    expect(isActiveIngestionStatus("WAITING_FOR_REVIEW")).toBe(true);
  });

  it("does not treat terminal ingestion statuses as active", () => {
    expect(isActiveIngestionStatus("COMPLETED")).toBe(false);
    expect(isActiveIngestionStatus("FAILED")).toBe(false);
    expect(isActiveIngestionStatus("CANCELLED")).toBe(false);
  });
});

describe("ingestionQueuedPayload", () => {
  it("maps pending workflow runs to the public queued status", () => {
    expect(ingestionQueuedPayload({ id: "run-1", status: "PENDING" })).toEqual({
      ingestionRunId: "run-1",
      status: "QUEUED"
    });
  });

  it("returns active non-pending workflow statuses unchanged", () => {
    expect(ingestionQueuedPayload({ id: "run-1", status: "WAITING_FOR_REVIEW" })).toEqual({
      ingestionRunId: "run-1",
      status: "WAITING_FOR_REVIEW"
    });
  });
});
