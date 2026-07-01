import { describe, expect, it } from "vitest";

import { Prisma, ReviewStatus } from "@queans/db";

import {
  canPatchReviewItem,
  ingestionQueuedPayload,
  isActiveIngestionStatus,
  isPrismaUniqueConstraintError,
  mutableReviewItemWhere,
  reviewItemAlreadyClosedPayload,
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

describe("canPatchReviewItem", () => {
  it("allows open and assigned review work that has not been applied", () => {
    expect(canPatchReviewItem({ status: ReviewStatus.OPEN, appliedAt: null })).toBe(true);
    expect(canPatchReviewItem({ status: ReviewStatus.ASSIGNED, appliedAt: null })).toBe(true);
  });

  it("rejects terminal or already-applied review work", () => {
    expect(canPatchReviewItem({ status: ReviewStatus.APPROVED, appliedAt: null })).toBe(false);
    expect(canPatchReviewItem({ status: ReviewStatus.OPEN, appliedAt: new Date("2026-07-01T10:20:30.000Z") })).toBe(
      false
    );
  });
});

describe("mutableReviewItemWhere", () => {
  it("matches only unapplied open or assigned review work for write-time guarding", () => {
    expect(mutableReviewItemWhere("review-item-1")).toEqual({
      id: "review-item-1",
      status: { in: [ReviewStatus.OPEN, ReviewStatus.ASSIGNED] },
      appliedAt: null
    });
  });
});

describe("reviewItemAlreadyClosedPayload", () => {
  it("returns a stable conflict payload for closed review work", () => {
    expect(
      reviewItemAlreadyClosedPayload({
        status: ReviewStatus.APPROVED,
        appliedAt: new Date("2026-07-01T10:20:30.000Z")
      })
    ).toEqual({
      error: "REVIEW_ITEM_ALREADY_CLOSED",
      status: ReviewStatus.APPROVED,
      appliedAt: "2026-07-01T10:20:30.000Z"
    });
  });
});
