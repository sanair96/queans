import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    workflowRun: { updateMany: vi.fn() },
    blueprintDocument: { updateMany: vi.fn() },
    workflowEvent: { create: vi.fn() },
    $transaction: vi.fn()
  }
}));

vi.mock("@queans/db", () => ({
  Prisma: { JsonNull: null },
  prisma: mocks.prisma
}));

const { beginBlueprintWorkflow, completeBlueprintWorkflow, failBlueprintWorkflow } = await import("./blueprint.activities.js");

const input = {
  workflowRunId: "run-1",
  blueprintDocumentId: "blueprint-1"
};

describe("Blueprint workflow lifecycle activities", () => {
  beforeEach(() => {
    mocks.prisma.workflowRun.updateMany.mockReset();
    mocks.prisma.blueprintDocument.updateMany.mockReset();
    mocks.prisma.workflowEvent.create.mockReset();
    mocks.prisma.$transaction.mockReset();
    mocks.prisma.$transaction.mockResolvedValue([]);
  });

  it("claims a queued run once and marks its document processing", async () => {
    mocks.prisma.workflowRun.updateMany.mockResolvedValue({ count: 1 });

    await expect(beginBlueprintWorkflow(input)).resolves.toEqual({ started: true });
    const startCall: unknown = mocks.prisma.workflowRun.updateMany.mock.calls[0]?.[0];
    expect(startCall).toMatchObject({
      where: {
        id: "run-1",
        blueprintDocumentId: "blueprint-1",
        status: "PENDING"
      },
      data: { status: "RUNNING", currentStep: "ocr_document" }
    });
    expect(mocks.prisma.$transaction).toHaveBeenCalledOnce();
  });

  it("does not duplicate a processing transition when retried", async () => {
    mocks.prisma.workflowRun.updateMany.mockResolvedValue({ count: 0 });

    await expect(beginBlueprintWorkflow(input)).resolves.toEqual({ started: false });
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("moves a completed extraction with a draft to ready-for-approval", async () => {
    mocks.prisma.workflowRun.updateMany.mockResolvedValue({ count: 1 });

    await expect(completeBlueprintWorkflow(input)).resolves.toEqual({ completed: true });
    const completionCall: unknown = mocks.prisma.blueprintDocument.updateMany.mock.calls[0]?.[0];
    expect(completionCall).toMatchObject({
      where: { id: "blueprint-1", status: "PROCESSING" },
      data: { status: "READY_FOR_APPROVAL" }
    });
  });

  it("fails a run and document once without passing OCR or extraction data through Temporal", async () => {
    mocks.prisma.workflowRun.updateMany.mockResolvedValue({ count: 1 });

    await expect(failBlueprintWorkflow(input)).resolves.toEqual({ failed: true });
    const failureRunCall: unknown = mocks.prisma.workflowRun.updateMany.mock.calls[0]?.[0];
    const failureDocumentCall: unknown = mocks.prisma.blueprintDocument.updateMany.mock.calls[0]?.[0];
    expect(failureRunCall).toMatchObject({
      where: { id: "run-1", blueprintDocumentId: "blueprint-1" },
      data: { status: "FAILED" }
    });
    expect(failureDocumentCall).toMatchObject({
      data: { status: "FAILED", extractionError: "Blueprint ingestion workflow failed." }
    });
  });
});
