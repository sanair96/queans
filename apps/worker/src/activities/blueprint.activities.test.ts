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
  blueprintExtraction: { extractRules: vi.fn() },
  parseBlueprintExtraction: vi.fn(),
  createPersistedBlueprintExtraction: vi.fn(),
  loadR2ConfigFromEnv: vi.fn(),
  loadMistralConfigFromEnv: vi.fn()
}));

vi.mock("@queans/db", () => ({
  Prisma: { JsonNull: null, DbNull: "DB_NULL" },
  prisma: mocks.prisma
}));

vi.mock("@queans/providers", () => ({
  loadMistralConfigFromEnv: mocks.loadMistralConfigFromEnv,
  loadR2ConfigFromEnv: mocks.loadR2ConfigFromEnv,
  blueprintExtractionProfile: "full_marking_scheme_v1",
  maxR2PresignExpiresSeconds: 900,
  R2ObjectStore: class {
    createPresignedRead = mocks.r2.createPresignedRead;
  },
  MistralOcrProvider: class {
    processDocumentUrl = mocks.ocr.processDocumentUrl;
  },
  MistralBlueprintLanguageAnalyzer: class {
    analyzePages = mocks.languageAnalysis.analyzePages;
  },
  createBlueprintRuleExtractorFromEnv: () => ({ extractRules: mocks.blueprintExtraction.extractRules }),
  createPersistedBlueprintExtraction: mocks.createPersistedBlueprintExtraction,
  parsePersistedBlueprintExtraction: mocks.parseBlueprintExtraction,
  BlueprintExtractionResponseError: class BlueprintExtractionResponseError extends Error {
    constructor(message: string, readonly rawJson: unknown) {
      super(message);
    }
  }
}));

const {
  analyzeBlueprintStructure,
  beginBlueprintWorkflow,
  completeBlueprintWorkflow,
  extractBlueprintRules,
  failBlueprintWorkflow,
  ocrBlueprintDocument,
  persistBlueprintDraft
} = await import("./blueprint.activities.js");
const { BlueprintExtractionResponseError } = await import("@queans/providers");

const input = {
  workflowRunId: "run-1",
  blueprintDocumentId: "blueprint-1",
  mode: "FULL" as const
};

const persistedLanguageAnalysis = {
  detectedLanguages: [{ tag: "hi", confidence: 0.99, pageNumbers: [1] }],
  primaryLanguage: { tag: "hi", source: "USER_CONFIRMED", confidence: 1, requiresConfirmation: false },
  mixedLanguagePageNumbers: [],
  multilingualRelationship: "MONOLINGUAL",
  metadata: {
    documentAnalysis: {
      documentType: "MARKING_SCHEME",
      isMarkingScheme: true,
      confidence: 0.99,
      titleLanguageTag: "hi",
      headerLanguageTag: "hi",
      evidencePageNumbers: [1],
      evaluatorInstructionPageNumbers: [],
      markingSchemePageNumbers: [1],
      paperCode: null
    }
  }
};

function persistedExtractionFromMockResult(result: unknown) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("Expected a Blueprint extraction result.");
  }
  const record = result as Record<string, unknown>;
  return {
    provider: record.provider,
    model: record.model,
    rules: record.rules,
    confidence: record.confidence,
    sourceReferences: record.sourceReferences,
    warnings: record.warnings,
    usage: record.usage,
    rawProviderResponse: record.rawJson
  };
}

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
    mocks.blueprintExtraction.extractRules.mockReset();
    mocks.parseBlueprintExtraction.mockReset();
    mocks.createPersistedBlueprintExtraction.mockReset();
    mocks.createPersistedBlueprintExtraction.mockImplementation(persistedExtractionFromMockResult);
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

  it("moves a completed extraction with an unreconciled draft to review", async () => {
    mocks.prisma.workflowRun.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.blueprintDocument.findUnique.mockResolvedValue({ extractionMetadataJson: { audit: { reconciled: false } } });

    await expect(completeBlueprintWorkflow(input)).resolves.toEqual({ completed: true });
    const completionCall: unknown = mocks.prisma.blueprintDocument.updateMany.mock.calls[0]?.[0];
    expect(completionCall).toMatchObject({
      where: { id: "blueprint-1", status: "PROCESSING" },
      data: { status: "NEEDS_REVIEW" }
    });
  });

  it("moves a completed reconciled extraction with a draft to ready", async () => {
    mocks.prisma.workflowRun.updateMany.mockResolvedValue({ count: 1 });
    mocks.prisma.blueprintDocument.findUnique.mockResolvedValue({
      extractionMetadataJson: {
        audit: { reconciled: true },
        recovery: { attempted: true, requestedQuestionNumbers: ["2"], pageNumbers: [1, 2, 3], recoveredQuestionNumbers: ["2"] }
      }
    });

    await expect(completeBlueprintWorkflow(input)).resolves.toEqual({ completed: true });
    const completionCall: unknown = mocks.prisma.blueprintDocument.updateMany.mock.calls[0]?.[0];
    expect(completionCall).toMatchObject({
      where: { id: "blueprint-1", status: "PROCESSING" },
      data: { status: "READY" }
    });
  });

  it("fails a run and document once without passing OCR or extraction data through Temporal", async () => {
    mocks.prisma.workflowRun.updateMany.mockResolvedValue({ count: 1 });

    await expect(failBlueprintWorkflow(input, { step: "OCR", message: "provider timed out" })).resolves.toEqual({ failed: true });
    const failureRunCall: unknown = mocks.prisma.workflowRun.updateMany.mock.calls[0]?.[0];
    const failureDocumentCall: unknown = mocks.prisma.blueprintDocument.updateMany.mock.calls[0]?.[0];
    expect(failureRunCall).toMatchObject({
      where: { id: "run-1", blueprintDocumentId: "blueprint-1" },
      data: { status: "FAILED", errorPayload: { code: "BLUEPRINT_WORKFLOW_FAILED", step: "OCR", message: "provider timed out" } }
    });
    expect(failureDocumentCall).toMatchObject({
      data: { status: "FAILED", extractionError: "Blueprint ingestion failed during OCR: provider timed out" }
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
        {
          pageNumber: 1,
          markdown: "# Section A",
          rawJson: { index: 0 },
          blocks: [{ blockType: "image", text: "page-1-image-1.png", confidence: 0.95, boundingBox: { x: 12 }, sourceAsset: { imageId: "image-1" }, rawJson: { type: "image" } }],
          images: [{ id: "image-1", fileName: "page-1-image-1.png", mimeType: "image/png", base64: "unused", boundingBox: { x: 20 }, rawJson: { id: "image-1" } }]
        },
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
      create: {
        markdownText: "# Section A",
        plainText: "Section A",
        ocrBlocks: {
          create: [{ blockType: "image", text: "page-1-image-1.png", confidence: 0.95, boundingBox: { x: 12 }, sourceAsset: { imageId: "image-1" }, rawJson: { type: "image" } }]
        },
        ocrAssets: {
          create: [{ sourceAssetId: "image-1", fileName: "page-1-image-1.png", mimeType: "image/png", boundingBox: { x: 20 }, rawJson: { id: "image-1" } }]
        }
      },
      update: {
        ocrBlocks: {
          deleteMany: {},
          create: [{ blockType: "image", text: "page-1-image-1.png", confidence: 0.95, boundingBox: { x: 12 }, sourceAsset: { imageId: "image-1" }, rawJson: { type: "image" } }]
        },
        ocrAssets: {
          deleteMany: {},
          create: [{ sourceAssetId: "image-1", fileName: "page-1-image-1.png", mimeType: "image/png", boundingBox: { x: 20 }, rawJson: { id: "image-1" } }]
        }
      }
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
      documentAnalysis: {
        documentType: "QUESTION_PAPER",
        isMarkingScheme: true,
        confidence: 0.98,
        titleLanguageTag: "en",
        headerLanguageTag: "en",
        evidencePageNumbers: [1],
        evaluatorInstructionPageNumbers: [1],
        markingSchemePageNumbers: [2],
        paperCode: null
      },
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

  it("extracts native rules in the selected primary language and stores raw provider evidence separately", async () => {
    mocks.prisma.blueprintDocument.findUnique.mockResolvedValue({
      id: "blueprint-1",
      languageDetectionMetadata: persistedLanguageAnalysis,
      ocrPages: [{
        pageNumber: 1,
        markdownText: "# खंड अ\nसभी प्रश्नों के उत्तर दीजिए",
        plainText: "खंड अ\nसभी प्रश्नों के उत्तर दीजिए",
        ocrConfidence: 0.96,
        ocrBlocks: [{ blockType: "table", text: "1. पांच अंक", confidence: 0.9, boundingBox: { x: 10 }, sourceAsset: { imageId: "image-1" } }],
        ocrAssets: [{ sourceAssetId: "image-1", fileName: "table.png", mimeType: "image/png", boundingBox: { x: 20 }, rawJson: { provider: "mistral" } }]
      }]
    });
    mocks.blueprintExtraction.extractRules.mockResolvedValue({
      provider: "mistral",
      model: "mistral-small-latest",
      rules: {
        document_metadata: { title: null, subject: "Hindi", examination: null, paper_code: null, session: null, total_marks: 10, source_pages: [1] },
        evaluation_rules: [],
        assessment_blueprint: { sections: [{ name: "खंड अ", printed_identifier: null, question_range: "1", question_type: "Short answer", choice_rules: [], declared_marks: 10, source_pages: [1] }], total_marks: 10, source_pages: [1] },
        question_index: [{ number: "1", section: "खंड अ", marks: 10, question_type: "Short answer", part_labels: [], alternative_labels: [], source_pages: [1] }]
      },
      confidence: 0.91,
      sourceReferences: [{ pageNumber: 1, languageTag: "hi", snippet: "सभी प्रश्नों" }],
      warnings: [],
      audit: {
        reconciled: true,
        expectedQuestionNumbers: ["1"],
        extractedQuestionNumbers: ["1"],
        missingQuestionNumbers: [],
        duplicateQuestionNumbers: [],
        conflicts: [],
        markReconciliation: { status: "MATCH", declaredTotalMarks: 10, extractedTotalMarks: 10, choiceAdjustedSections: [] },
        unparseableRanges: []
      },
      recovery: { attempted: false, requestedQuestionNumbers: [], pageNumbers: [], recoveredQuestionNumbers: [] },
      rawJson: { choices: [{ message: { content: "provider response" } }] },
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 }
    });

    await expect(extractBlueprintRules(input)).resolves.toBeUndefined();

    expect(mocks.blueprintExtraction.extractRules).toHaveBeenCalledWith({
      primaryLanguage: "hi",
      pages: [{
        pageNumber: 1,
        markdown: "# खंड अ\nसभी प्रश्नों के उत्तर दीजिए",
        plainText: "खंड अ\nसभी प्रश्नों के उत्तर दीजिए",
        averageConfidence: 0.96,
        blocks: [{ blockType: "table", text: "1. पांच अंक", confidence: 0.9, boundingBox: { x: 10 }, sourceAsset: { imageId: "image-1" } }],
        assets: [{ sourceAssetId: "image-1", fileName: "table.png", mimeType: "image/png", boundingBox: { x: 20 }, metadata: { provider: "mistral" } }]
      }],
    });
    const extractionUpdate: unknown = mocks.prisma.blueprintDocument.update.mock.calls[0]?.[0];
    expect(extractionUpdate).toMatchObject({
      where: { id: "blueprint-1" },
      data: {
        rawExtractionJson: {
          provider: "mistral",
          model: "mistral-small-latest",
          rawProviderResponse: { choices: [{ message: { content: "provider response" } }] }
        },
        extractionMetadataJson: {
          audit: { reconciled: true },
          recovery: { attempted: false }
        },
        extractionError: null
      }
    });
  });

  it("requires primary-language selection before extraction instead of producing an approvable draft", async () => {
    mocks.prisma.blueprintDocument.findUnique.mockResolvedValue({
      id: "blueprint-1",
      languageDetectionMetadata: {
        ...persistedLanguageAnalysis,
        primaryLanguage: { tag: null, source: "UNRESOLVED", confidence: null, requiresConfirmation: true }
      },
      ocrPages: [{ pageNumber: 1, markdownText: "source" }]
    });

    await expect(extractBlueprintRules(input)).resolves.toBeUndefined();

    expect(mocks.blueprintExtraction.extractRules).not.toHaveBeenCalled();
    expect(mocks.prisma.blueprintDocument.update).toHaveBeenCalledWith({
      where: { id: "blueprint-1" },
      data: {
        status: "NEEDS_REVIEW",
        extractionError: "A primary language must be selected or confirmed before Blueprint rules can be extracted."
      }
    });
  });

  it("requires confirmation for an uncertain inferred primary language before extraction", async () => {
    mocks.prisma.blueprintDocument.findUnique.mockResolvedValue({
      id: "blueprint-1",
      languageDetectionMetadata: {
        ...persistedLanguageAnalysis,
        primaryLanguage: { tag: "hi", source: "INFERRED", confidence: 0.7, requiresConfirmation: true }
      },
      ocrPages: [{ pageNumber: 1, markdownText: "source" }]
    });

    await expect(extractBlueprintRules(input)).resolves.toBeUndefined();

    expect(mocks.blueprintExtraction.extractRules).not.toHaveBeenCalled();
    expect(mocks.prisma.blueprintDocument.update).toHaveBeenCalledWith({
      where: { id: "blueprint-1" },
      data: {
        status: "NEEDS_REVIEW",
        extractionError: "A primary language must be selected or confirmed before Blueprint rules can be extracted."
      }
    });
  });

  it("preserves a safe invalid provider response and marks the Blueprint for review", async () => {
    mocks.prisma.blueprintDocument.findUnique.mockResolvedValue({
      id: "blueprint-1",
      languageDetectionMetadata: persistedLanguageAnalysis,
      ocrPages: [{ pageNumber: 1, markdownText: "source" }]
    });
    mocks.blueprintExtraction.extractRules.mockRejectedValue(
      new BlueprintExtractionResponseError("rules must be JSON", { choices: [{ message: { content: "invalid" } }] })
    );

    await expect(extractBlueprintRules(input)).resolves.toBeUndefined();

    expect(mocks.prisma.blueprintDocument.update).toHaveBeenCalledWith({
      where: { id: "blueprint-1" },
      data: {
        status: "NEEDS_REVIEW",
        rawExtractionJson: { choices: [{ message: { content: "invalid" } }] },
        extractionError: "Blueprint extraction response is invalid: rules must be JSON"
      }
    });
  });

  it("keeps raw provider output when extracted rules fail generic JSON validation", async () => {
    mocks.prisma.blueprintDocument.findUnique.mockResolvedValue({
      id: "blueprint-1",
      languageDetectionMetadata: persistedLanguageAnalysis,
      ocrPages: [{ pageNumber: 1, markdownText: "source" }]
    });
    mocks.blueprintExtraction.extractRules.mockResolvedValue({
      provider: "mistral",
      model: "mistral-small-latest",
      rules: { invalid: new Date() },
      confidence: 0.8,
      sourceReferences: [],
      warnings: [],
      rawJson: { choices: [{ message: { content: "provider response" } }] },
      usage: {}
    });

    await expect(extractBlueprintRules(input)).resolves.toBeUndefined();

    const reviewUpdate: unknown = mocks.prisma.blueprintDocument.update.mock.calls[0]?.[0];
    expect(reviewUpdate).toMatchObject({
      where: { id: "blueprint-1" },
      data: {
        status: "NEEDS_REVIEW",
        rawExtractionJson: {
          provider: "mistral",
          model: "mistral-small-latest",
          rawProviderResponse: { choices: [{ message: { content: "provider response" } }] }
        }
      }
    });
    expect(JSON.stringify(reviewUpdate)).toContain("Blueprint extraction draft is invalid");
  });

  it("persists a valid unreconciled draft, including the JSON null primitive and recovery details", async () => {
    mocks.prisma.blueprintDocument.findUnique.mockResolvedValue({
      id: "blueprint-1",
      status: "NEEDS_REVIEW",
      languageDetectionMetadata: persistedLanguageAnalysis,
      extractionMetadataJson: {
        audit: { reconciled: false, missingQuestionNumbers: ["2"] },
        recovery: {
          attempted: true,
          requestedQuestionNumbers: ["2"],
          pageNumbers: [1, 2, 3],
          recoveredQuestionNumbers: [],
          failure: { message: "recovery provider unavailable" }
        }
      },
      rawExtractionJson: { choices: [{ message: { content: "provider response" } }] }
    });
    mocks.parseBlueprintExtraction.mockReturnValue({
      provider: "mistral",
      model: "mistral-small-latest",
      rules: {
        document_metadata: { title: null, subject: "Hindi", examination: null, paper_code: null, session: null, total_marks: 10, source_pages: [1] },
        evaluation_rules: [],
        assessment_blueprint: { sections: [{ name: "Section A", printed_identifier: null, question_range: "1-2", question_type: "Short answer", choice_rules: [], declared_marks: 10, source_pages: [1, 2] }], total_marks: 10, source_pages: [1, 2] },
        question_index: [{ number: "1", section: "Section A", marks: 5, question_type: "Short answer", part_labels: [], alternative_labels: [], source_pages: [1] }]
      },
      confidence: 0.8,
      sourceReferences: [{ pageNumber: 1, languageTag: "hi" }],
      warnings: ["OCR table boundary uncertain"],
      usage: {}
    });

    await expect(persistBlueprintDraft(input)).resolves.toBeUndefined();

    const draftUpdate: unknown = mocks.prisma.blueprintDocument.update.mock.calls[0]?.[0];
    expect(draftUpdate).toMatchObject({
      where: { id: "blueprint-1" },
      data: {
        draftRulesJson: { question_index: [{ number: "1", marks: 5 }] },
        confidenceSummaryJson: { extraction: 0.8 },
        extractionMetadataJson: {
          audit: { reconciled: false, missingQuestionNumbers: ["2"] },
          recovery: {
            attempted: true,
            requestedQuestionNumbers: ["2"],
            pageNumbers: [1, 2, 3],
            recoveredQuestionNumbers: [],
            failure: { message: "recovery provider unavailable" }
          }
        },
        extractionError: null
      }
    });
  });
});
