import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    workflowRun: { updateMany: vi.fn() },
    blueprintDocument: { updateMany: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
    blueprintOcrPage: { upsert: vi.fn(), update: vi.fn() },
    workflowEvent: { create: vi.fn() },
    $transaction: vi.fn()
  },
  r2: { createPresignedRead: vi.fn() },
  ocr: { processDocumentUrl: vi.fn() },
  languageAnalysis: { analyzePages: vi.fn() },
  loadR2ConfigFromEnv: vi.fn(),
  loadMistralConfigFromEnv: vi.fn()
}));

vi.mock("@queans/db", () => ({
  Prisma: { JsonNull: null },
  prisma: mocks.prisma
}));

vi.mock("@queans/providers", () => ({
  loadMistralConfigFromEnv: mocks.loadMistralConfigFromEnv,
  loadR2ConfigFromEnv: mocks.loadR2ConfigFromEnv,
  maxR2PresignExpiresSeconds: 900,
  R2ObjectStore: class {
    createPresignedRead = mocks.r2.createPresignedRead;
  },
  MistralOcrProvider: class {
    processDocumentUrl = mocks.ocr.processDocumentUrl;
  },
  MistralBlueprintLanguageAnalyzer: class {
    analyzePages = mocks.languageAnalysis.analyzePages;
  }
}));

const {
  analyzeBlueprintStructure,
  beginBlueprintWorkflow,
  completeBlueprintWorkflow,
  failBlueprintWorkflow,
  ocrBlueprintDocument
} = await import("./blueprint.activities.js");

const input = {
  workflowRunId: "run-1",
  blueprintDocumentId: "blueprint-1"
};

describe("Blueprint workflow lifecycle activities", () => {
  beforeEach(() => {
    mocks.prisma.workflowRun.updateMany.mockReset();
    mocks.prisma.blueprintDocument.updateMany.mockReset();
    mocks.prisma.blueprintDocument.update.mockReset();
    mocks.prisma.blueprintDocument.findUnique.mockReset();
    mocks.prisma.blueprintOcrPage.upsert.mockReset();
    mocks.prisma.blueprintOcrPage.update.mockReset();
    mocks.prisma.workflowEvent.create.mockReset();
    mocks.prisma.$transaction.mockReset();
    mocks.r2.createPresignedRead.mockReset();
    mocks.ocr.processDocumentUrl.mockReset();
    mocks.languageAnalysis.analyzePages.mockReset();
    mocks.loadR2ConfigFromEnv.mockReset();
    mocks.loadMistralConfigFromEnv.mockReset();
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

  it("reads the private Blueprint upload through a short-lived URL and upserts each OCR page", async () => {
    mocks.prisma.blueprintDocument.findUnique.mockResolvedValue({
      id: "blueprint-1",
      uploadObject: { objectKey: "blueprints/blueprint-1.pdf" }
    });
    mocks.r2.createPresignedRead.mockResolvedValue("https://r2.example.test/temporary-read");
    mocks.ocr.processDocumentUrl.mockResolvedValue({
      provider: "MISTRAL",
      model: "mistral-ocr-latest",
      usage: { pagesProcessed: 2 },
      pages: [
        { pageNumber: 1, markdown: "# Section A", rawJson: { index: 0 } },
        { pageNumber: 2, markdown: "# Section B", plainText: "Section B", averageConfidence: 0.92, rawJson: { index: 1 } }
      ]
    });
    mocks.prisma.$transaction.mockImplementation((callback: (tx: typeof mocks.prisma) => unknown) =>
      Promise.resolve(callback(mocks.prisma))
    );

    await expect(ocrBlueprintDocument(input)).resolves.toBeUndefined();

    expect(mocks.r2.createPresignedRead).toHaveBeenCalledWith("blueprints/blueprint-1.pdf", 900);
    expect(mocks.ocr.processDocumentUrl).toHaveBeenCalledWith("https://r2.example.test/temporary-read");
    expect(mocks.prisma.blueprintDocument.update).toHaveBeenCalledWith({
      where: { id: "blueprint-1" },
      data: { status: "PROCESSING", pageCount: 2 }
    });
    expect(mocks.prisma.blueprintOcrPage.upsert).toHaveBeenCalledTimes(2);
    const firstOcrPageUpsert: unknown = mocks.prisma.blueprintOcrPage.upsert.mock.calls[0]?.[0];
    expect(firstOcrPageUpsert).toMatchObject({
      where: { blueprintDocumentId_pageNumber: { blueprintDocumentId: "blueprint-1", pageNumber: 1 } },
      create: { markdownText: "# Section A", plainText: "Section A" }
    });
  });

  it("persists OCR pages independently so a retry can resume after a later page fails", async () => {
    mocks.prisma.blueprintDocument.findUnique.mockResolvedValue({
      id: "blueprint-1",
      uploadObject: { objectKey: "blueprints/blueprint-1.pdf" }
    });
    mocks.r2.createPresignedRead.mockResolvedValue("https://r2.example.test/temporary-read");
    mocks.ocr.processDocumentUrl.mockResolvedValue({
      provider: "MISTRAL",
      model: "mistral-ocr-latest",
      usage: { pagesProcessed: 2 },
      pages: [
        { pageNumber: 1, markdown: "Page one", rawJson: { index: 0 } },
        { pageNumber: 2, markdown: "Page two", rawJson: { index: 1 } }
      ]
    });
    mocks.prisma.blueprintOcrPage.upsert.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("database unavailable"));

    await expect(ocrBlueprintDocument(input)).rejects.toThrow("database unavailable");

    expect(mocks.prisma.blueprintOcrPage.upsert).toHaveBeenCalledTimes(2);
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("persists page-level language evidence and advisory structure metadata without creating rules JSON", async () => {
    mocks.prisma.blueprintDocument.findUnique.mockResolvedValue({
      id: "blueprint-1",
      primaryLanguage: null,
      primaryLanguageSource: "UNRESOLVED",
      ocrPages: [
        { pageNumber: 1, markdownText: "# Question Paper\nTotal Marks: 80", plainText: null },
        { pageNumber: 2, markdownText: "# प्रश्न पत्र\nकुल अंक: 80", plainText: null }
      ]
    });
    mocks.languageAnalysis.analyzePages.mockResolvedValue({
      provider: "mistral",
      model: "mistral-small-latest",
      detectedLanguages: [
        { tag: "en", confidence: 0.99, pageNumbers: [1] },
        { tag: "hi", confidence: 0.99, pageNumbers: [2] }
      ],
      primaryLanguage: { tag: "en", confidence: 0.94 },
      mixedLanguagePageNumbers: [],
      multilingualRelationship: "DUPLICATE_TRANSLATIONS",
      pageLanguages: [
        { pageNumber: 1, languages: [{ tag: "en", confidence: 0.99 }] },
        { pageNumber: 2, languages: [{ tag: "hi", confidence: 0.99 }] }
      ],
      rawJson: { id: "language-analysis" },
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 }
    });
    mocks.prisma.$transaction.mockImplementation((callback: (tx: typeof mocks.prisma) => unknown) =>
      Promise.resolve(callback(mocks.prisma))
    );

    await expect(analyzeBlueprintStructure(input)).resolves.toBeUndefined();

    expect(mocks.prisma.blueprintOcrPage.update).toHaveBeenCalledTimes(2);
    expect(mocks.languageAnalysis.analyzePages).toHaveBeenCalledWith({
      pages: [
        { pageNumber: 1, markdown: "# Question Paper\nTotal Marks: 80" },
        { pageNumber: 2, markdown: "# प्रश्न पत्र\nकुल अंक: 80" }
      ]
    });
    const firstOcrPageUpdate: unknown = mocks.prisma.blueprintOcrPage.update.mock.calls[0]?.[0];
    expect(firstOcrPageUpdate).toMatchObject({ data: { detectedLanguages: [{ tag: "en", pageNumbers: [1] }] } });
    const documentUpdate: unknown = mocks.prisma.blueprintDocument.update.mock.calls[0]?.[0];
    expect(documentUpdate).toMatchObject({
      where: { id: "blueprint-1" },
      data: {
        primaryLanguage: "en",
        primaryLanguageSource: "INFERRED",
        languageDetectionMetadata: { multilingualRelationship: "DUPLICATE_TRANSLATIONS" }
      }
    });
  });
});
