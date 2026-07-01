import { describe, expect, it } from "vitest";

import { Prisma } from "@queans/db";

import { isPrismaUniqueConstraintError, uploadCompletionPayload } from "./routes.js";

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
