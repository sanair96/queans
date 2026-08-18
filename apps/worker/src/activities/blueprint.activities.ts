import {
  blueprintExtractionEnvelopeSchema,
  blueprintLanguageAnalysisSchema,
  blueprintRulesSchema,
  type BlueprintIngestionWorkflowInput
} from "@queans/core";
import { Prisma, prisma } from "@queans/db";
import {
  loadMistralConfigFromEnv,
  loadR2ConfigFromEnv,
  maxR2PresignExpiresSeconds,
  BlueprintExtractionResponseError,
  createPersistedBlueprintExtraction,
  createBlueprintRuleExtractorFromEnv,
  MistralBlueprintLanguageAnalyzer,
  MistralOcrProvider,
  parsePersistedBlueprintExtraction,
  R2ObjectStore
} from "@queans/providers";
import type { BlueprintWorkflowFailure } from "../workflows/blueprint-ingestion.workflow.js";

import { analyzeBlueprintOcrPages, plainTextFromMarkdown } from "./blueprint-analysis.js";
import { toInputJson, toNullableInputJson } from "../json.js";

export async function ocrBlueprintDocument(input: BlueprintIngestionWorkflowInput) {
  const blueprintDocument = await prisma.blueprintDocument.findUnique({
    where: { id: input.blueprintDocumentId },
    include: { uploadObject: true }
  });
  if (!blueprintDocument) {
    throw new Error(`Blueprint document ${input.blueprintDocumentId} not found`);
  }

  const objectStore = new R2ObjectStore(loadR2ConfigFromEnv(process.env));
  const documentUrl = await objectStore.createPresignedRead(
    blueprintDocument.uploadObject.objectKey,
    maxR2PresignExpiresSeconds
  );
  const ocrProvider = new MistralOcrProvider(loadMistralConfigFromEnv(process.env));
  const result = await ocrProvider.processDocumentUrl(documentUrl);
  assertBlueprintOcrPages(result.pages);

  await prisma.blueprintDocument.update({
    where: { id: blueprintDocument.id },
    data: {
      status: "PROCESSING",
      pageCount: result.pages.length
    }
  });

  for (const page of result.pages) {
    const markdown = page.markdown;
    const plainText = page.plainText ?? plainTextFromMarkdown(markdown);
    await prisma.blueprintOcrPage.upsert({
      where: {
        blueprintDocumentId_pageNumber: {
          blueprintDocumentId: blueprintDocument.id,
          pageNumber: page.pageNumber
        }
      },
      create: {
        blueprintDocumentId: blueprintDocument.id,
        pageNumber: page.pageNumber,
        markdownText: markdown,
        plainText,
        ocrConfidence: page.averageConfidence ?? null,
        ocrBlocks: {
          create: (page.blocks ?? []).map((block) => ({
            blockType: block.blockType,
            text: block.text,
            confidence: block.confidence ?? null,
            boundingBox: toNullableInputJson(block.boundingBox),
            sourceAsset: toNullableInputJson(block.sourceAsset),
            rawJson: toNullableInputJson(block.rawJson)
          }))
        },
        ocrAssets: {
          create: (page.images ?? []).map((image) => ({
            sourceAssetId: image.id,
            fileName: image.fileName,
            mimeType: image.mimeType,
            boundingBox: toNullableInputJson(image.boundingBox),
            rawJson: toNullableInputJson(image.rawJson)
          }))
        },
        providerMetadata: toInputJson({
          provider: result.provider,
          model: result.model,
          page: page.rawJson ?? null,
          usage: result.usage
        })
      },
      update: {
        markdownText: markdown,
        plainText,
        ocrConfidence: page.averageConfidence ?? null,
        ocrBlocks: {
          deleteMany: {},
          create: (page.blocks ?? []).map((block) => ({
            blockType: block.blockType,
            text: block.text,
            confidence: block.confidence ?? null,
            boundingBox: toNullableInputJson(block.boundingBox),
            sourceAsset: toNullableInputJson(block.sourceAsset),
            rawJson: toNullableInputJson(block.rawJson)
          }))
        },
        ocrAssets: {
          deleteMany: {},
          create: (page.images ?? []).map((image) => ({
            sourceAssetId: image.id,
            fileName: image.fileName,
            mimeType: image.mimeType,
            boundingBox: toNullableInputJson(image.boundingBox),
            rawJson: toNullableInputJson(image.rawJson)
          }))
        },
        providerMetadata: toInputJson({
          provider: result.provider,
          model: result.model,
          page: page.rawJson ?? null,
          usage: result.usage
        })
      }
    });
  }
}

export async function analyzeBlueprintStructure(input: BlueprintIngestionWorkflowInput) {
  const blueprintDocument = await prisma.blueprintDocument.findUnique({
    where: { id: input.blueprintDocumentId },
    include: { ocrPages: { orderBy: { pageNumber: "asc" } } }
  });
  if (!blueprintDocument) {
    throw new Error(`Blueprint document ${input.blueprintDocumentId} not found`);
  }

  const languageProvider = new MistralBlueprintLanguageAnalyzer(loadMistralConfigFromEnv(process.env));
  const providerLanguageAnalysis = await languageProvider.analyzePages({
    pages: blueprintDocument.ocrPages.map((page) => ({ pageNumber: page.pageNumber, markdown: page.markdownText }))
  });
  const analysis = analyzeBlueprintOcrPages({
    pages: blueprintDocument.ocrPages.map((page) => ({
      pageNumber: page.pageNumber,
      markdownText: page.markdownText,
      plainText: page.plainText
    })),
    primaryLanguage: blueprintDocument.primaryLanguage,
    primaryLanguageSource: blueprintDocument.primaryLanguageSource,
    providerLanguageAnalysis
  });

  await prisma.$transaction(async (tx) => {
    for (const page of analysis.pages) {
      await tx.blueprintOcrPage.update({
        where: {
          blueprintDocumentId_pageNumber: {
            blueprintDocumentId: blueprintDocument.id,
            pageNumber: page.pageNumber
          }
        },
        data: {
          detectedLanguages: toInputJson(page.detectedLanguages)
        }
      });
    }

    await tx.blueprintDocument.update({
      where: { id: blueprintDocument.id },
      data: {
        detectedLanguages: toInputJson(analysis.languageAnalysis.detectedLanguages),
        primaryLanguage: analysis.languageAnalysis.primaryLanguage.tag,
        primaryLanguageSource: analysis.languageAnalysis.primaryLanguage.source,
        documentType: documentTypeFromLanguageMetadata(analysis.languageAnalysis.metadata),
        languageDetectionMetadata: toInputJson(analysis.languageAnalysis)
      }
    });
  });
}

export async function extractBlueprintRules(input: BlueprintIngestionWorkflowInput) {
  const blueprintDocument = await prisma.blueprintDocument.findUnique({
    where: { id: input.blueprintDocumentId },
    include: {
      ocrPages: {
        orderBy: { pageNumber: "asc" },
        include: { ocrBlocks: true, ocrAssets: true }
      }
    }
  });
  if (!blueprintDocument) {
    throw new Error(`Blueprint document ${input.blueprintDocumentId} not found`);
  }
  if (blueprintDocument.rawExtractionJson) {
    return;
  }
  const languageAnalysis = blueprintLanguageAnalysisSchema.safeParse(blueprintDocument.languageDetectionMetadata);
  if (!languageAnalysis.success) {
    await markBlueprintNeedsReview({
      blueprintDocumentId: blueprintDocument.id,
      error: "Language and document analysis must complete before Blueprint rules can be extracted."
    });
    return;
  }
  const primaryLanguage = languageAnalysis.data.primaryLanguage.tag;
  const requiresLanguageConfirmation = languageAnalysis.data.primaryLanguage.requiresConfirmation;
  if (!primaryLanguage || requiresLanguageConfirmation) {
    await markBlueprintNeedsReview({
      blueprintDocumentId: blueprintDocument.id,
      error: "A primary language must be selected or confirmed before Blueprint rules can be extracted."
    });
    return;
  }

  if (!isRecognizedBlueprintDocument(languageAnalysis.data.metadata)) {
    await markBlueprintNeedsReview({
      blueprintDocumentId: blueprintDocument.id,
      error: "This document could not be recognized as a question paper or marking scheme. Check the upload and try again."
    });
    return;
  }

  const extractor = createBlueprintRuleExtractorFromEnv(process.env);
  let rawExtractionJson: unknown;
  try {
    const extraction = await extractor.extractRules({
      primaryLanguage,
      pages: blueprintDocument.ocrPages.map((page) => blueprintStructuredOcrPage(page))
    });
    const persistedExtraction = createPersistedBlueprintExtraction(extraction);
    rawExtractionJson = persistedExtraction;
    const envelope = blueprintExtractionEnvelopeSchema.parse({
      rules: extraction.rules,
      languageAnalysis: languageAnalysis.data,
      confidence: extraction.confidence,
      sourceReferences: extraction.sourceReferences,
      warnings: extraction.warnings,
      providerMetadata: {
        provider: extraction.provider,
        model: extraction.model,
        usage: definedValues(extraction.usage)
      }
    });

    await prisma.blueprintDocument.update({
      where: { id: blueprintDocument.id },
      data: {
        rawExtractionJson: toInputJson(persistedExtraction),
        extractionMetadataJson: toInputJson({
          confidence: envelope.confidence,
          sourceReferences: envelope.sourceReferences,
          warnings: envelope.warnings,
          audit: extraction.audit ?? null,
          recovery: extraction.recovery ?? null,
          schemaVersion: 2,
          documentType: documentTypeFromLanguageMetadata(languageAnalysis.data.metadata),
          providerMetadata: envelope.providerMetadata
        }),
        extractionError: null
      }
    });
  } catch (error) {
    if (error instanceof BlueprintExtractionResponseError) {
      await markBlueprintNeedsReview({
        blueprintDocumentId: blueprintDocument.id,
        error: `Blueprint extraction response is invalid: ${error.message}`,
        rawExtractionJson: error.rawJson
      });
      return;
    }
    if (rawExtractionJson !== undefined) {
      await markBlueprintNeedsReview({
        blueprintDocumentId: blueprintDocument.id,
        error: `Blueprint extraction draft is invalid: ${error instanceof Error ? error.message : "unknown validation error"}`,
        rawExtractionJson
      });
      return;
    }
    throw error;
  }
}

function isRecognizedBlueprintDocument(metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const documentAnalysis = (metadata as Record<string, unknown>).documentAnalysis;
  if (!documentAnalysis || typeof documentAnalysis !== "object" || Array.isArray(documentAnalysis)) return false;
  const record = documentAnalysis as Record<string, unknown>;
  return ["QUESTION_PAPER", "MARKING_SCHEME"].includes(String(record.documentType)) && typeof record.confidence === "number" && record.confidence >= 0.7;
}

function documentTypeFromLanguageMetadata(metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const documentAnalysis = (metadata as Record<string, unknown>).documentAnalysis;
  if (!documentAnalysis || typeof documentAnalysis !== "object" || Array.isArray(documentAnalysis)) return null;
  const documentType = (documentAnalysis as Record<string, unknown>).documentType;
  return documentType === "QUESTION_PAPER" || documentType === "MARKING_SCHEME" ? documentType : null;
}

export async function persistBlueprintDraft(input: BlueprintIngestionWorkflowInput) {
  const blueprintDocument = await prisma.blueprintDocument.findUnique({
    where: { id: input.blueprintDocumentId }
  });
  if (!blueprintDocument) {
    throw new Error(`Blueprint document ${input.blueprintDocumentId} not found`);
  }
  if (!blueprintDocument.rawExtractionJson) {
    return;
  }
  try {
    const languageAnalysis = blueprintLanguageAnalysisSchema.parse(blueprintDocument.languageDetectionMetadata);
    const extraction = parsePersistedBlueprintExtraction(blueprintDocument.rawExtractionJson);
    const providerMetadata = providerMetadataFromExtractionMetadata(blueprintDocument.extractionMetadataJson) ?? {
      provider: extraction.provider,
      model: extraction.model,
      usage: definedValues(extraction.usage)
    };
    const envelope = blueprintExtractionEnvelopeSchema.parse({
      rules: extraction.rules,
      languageAnalysis,
      confidence: extraction.confidence,
      sourceReferences: extraction.sourceReferences,
      warnings: extraction.warnings,
      providerMetadata
    });
    const structuralRules = blueprintRulesSchema.parse(envelope.rules);

    await prisma.blueprintDocument.update({
      where: { id: blueprintDocument.id },
      data: {
        draftRulesJson: blueprintRulesInputJson(structuralRules),
        confidenceSummaryJson: toInputJson({ extraction: envelope.confidence }),
        extractionMetadataJson: toInputJson({
          confidence: envelope.confidence,
          sourceReferences: envelope.sourceReferences,
          warnings: envelope.warnings,
          audit: extractionMetadataValue(blueprintDocument.extractionMetadataJson, "audit"),
          recovery: extractionMetadataValue(blueprintDocument.extractionMetadataJson, "recovery"),
          schemaVersion: 2,
          documentType: documentTypeFromLanguageMetadata(languageAnalysis.metadata),
          providerMetadata: envelope.providerMetadata
        }),
        extractionError: null
      }
    });
  } catch (error) {
    await markBlueprintNeedsReview({
      blueprintDocumentId: blueprintDocument.id,
      error: `Blueprint extraction draft is invalid: ${error instanceof Error ? error.message : "unknown validation error"}`,
      rawExtractionJson: blueprintDocument.rawExtractionJson
    });
  }
}

export async function beginBlueprintWorkflow(input: BlueprintIngestionWorkflowInput) {
  const claimed = await prisma.workflowRun.updateMany({
    where: {
      id: input.workflowRunId,
      workflowType: "BLUEPRINT_INGESTION",
      blueprintDocumentId: input.blueprintDocumentId,
      status: "PENDING"
    },
    data: {
      status: "RUNNING",
      currentStep: input.mode === "FULL" ? "ocr_document" : "analyze_structure"
    }
  });
  if (claimed.count === 0) {
    return { started: false };
  }

  await prisma.$transaction([
    prisma.blueprintDocument.updateMany({
      where: {
        id: input.blueprintDocumentId,
        status: { in: ["QUEUED", "PROCESSING", "NEEDS_REVIEW", "FAILED"] }
      },
      data: {
        status: "PROCESSING",
        ...(input.mode === "RESUME_FROM_OCR"
          ? {
            rawExtractionJson: Prisma.DbNull,
            extractionMetadataJson: Prisma.DbNull,
            draftRulesJson: Prisma.DbNull,
            confidenceSummaryJson: Prisma.DbNull,
            extractionError: null
          }
          : {})
      }
    }),
    prisma.workflowEvent.create({
      data: {
        workflowRunId: input.workflowRunId,
        eventType: "BLUEPRINT_PROCESSING_STARTED",
        eventPayload: { blueprintDocumentId: input.blueprintDocumentId, mode: input.mode }
      }
    })
  ]);

  return { started: true };
}

export async function completeBlueprintWorkflow(input: BlueprintIngestionWorkflowInput) {
  const blueprintDocument = await prisma.blueprintDocument.findUnique({
    where: { id: input.blueprintDocumentId },
    select: { extractionMetadataJson: true }
  });
  const finalBlueprintStatus = blueprintAuditReconciled(blueprintDocument?.extractionMetadataJson)
    ? "READY"
    : "NEEDS_REVIEW";

  const claimed = await prisma.workflowRun.updateMany({
    where: {
      id: input.workflowRunId,
      workflowType: "BLUEPRINT_INGESTION",
      blueprintDocumentId: input.blueprintDocumentId,
      status: "RUNNING"
    },
    data: {
      status: "COMPLETED",
      currentStep: "complete",
      completedAt: new Date()
    }
  });
  if (claimed.count === 0) {
    return { completed: false };
  }

  await prisma.$transaction([
    prisma.blueprintDocument.updateMany({
      where: {
        id: input.blueprintDocumentId,
        status: "PROCESSING",
        draftRulesJson: { not: Prisma.DbNull }
      },
      data: { status: finalBlueprintStatus }
    }),
    prisma.workflowEvent.create({
      data: {
        workflowRunId: input.workflowRunId,
        eventType: "BLUEPRINT_WORKFLOW_COMPLETED",
        eventPayload: { blueprintDocumentId: input.blueprintDocumentId }
      }
    })
  ]);

  return { completed: true };
}

export async function failBlueprintWorkflow(input: BlueprintIngestionWorkflowInput, failure: BlueprintWorkflowFailure) {
  const detail = `Blueprint ingestion failed during ${failure.step}: ${failure.message}`;
  const claimed = await prisma.workflowRun.updateMany({
    where: {
      id: input.workflowRunId,
      workflowType: "BLUEPRINT_INGESTION",
      blueprintDocumentId: input.blueprintDocumentId,
      status: { in: ["PENDING", "RUNNING"] }
    },
    data: {
      status: "FAILED",
      errorPayload: { code: "BLUEPRINT_WORKFLOW_FAILED", step: failure.step, message: failure.message },
      completedAt: new Date()
    }
  });
  if (claimed.count === 0) {
    return { failed: false };
  }

  await prisma.$transaction([
    prisma.blueprintDocument.updateMany({
      where: {
        id: input.blueprintDocumentId,
        status: { in: ["QUEUED", "PROCESSING"] }
      },
      data: {
        status: "FAILED",
        extractionError: detail
      }
    }),
    prisma.workflowEvent.create({
      data: {
        workflowRunId: input.workflowRunId,
        eventType: "BLUEPRINT_WORKFLOW_FAILED",
        eventPayload: { blueprintDocumentId: input.blueprintDocumentId, step: failure.step, message: failure.message }
      }
    })
  ]);

  return { failed: true };
}

function assertBlueprintOcrPages(pages: Array<{ pageNumber: number }>) {
  if (pages.length === 0) {
    throw new Error("Blueprint OCR returned no pages.");
  }

  const pageNumbers = new Set<number>();
  for (const page of pages) {
    if (!Number.isInteger(page.pageNumber) || page.pageNumber < 1) {
      throw new Error("Blueprint OCR returned an invalid page number.");
    }
    if (pageNumbers.has(page.pageNumber)) {
      throw new Error(`Blueprint OCR returned duplicate page ${page.pageNumber}.`);
    }
    pageNumbers.add(page.pageNumber);
  }
}

async function markBlueprintNeedsReview(input: {
  blueprintDocumentId: string;
  error: string;
  rawExtractionJson?: unknown;
}) {
  await prisma.blueprintDocument.update({
    where: { id: input.blueprintDocumentId },
    data: {
      status: "NEEDS_REVIEW",
      ...(input.rawExtractionJson === undefined ? {} : { rawExtractionJson: toInputJson(input.rawExtractionJson) }),
      extractionError: input.error
    }
  });
}

function blueprintRulesInputJson(value: unknown) {
  return value === null ? Prisma.JsonNull : toInputJson(value);
}

function blueprintStructuredOcrPage(page: {
  pageNumber: number;
  markdownText: string;
  plainText: string | null;
  ocrConfidence: number | null;
  ocrBlocks: Array<{
    blockType: string;
    text: string;
    confidence: number | null;
    boundingBox: unknown;
    sourceAsset: unknown;
  }>;
  ocrAssets: Array<{
    sourceAssetId: string;
    fileName: string;
    mimeType: string;
    boundingBox: unknown;
    rawJson: unknown;
  }>;
}) {
  return {
    pageNumber: page.pageNumber,
    markdown: page.markdownText,
    plainText: page.plainText,
    averageConfidence: page.ocrConfidence,
    blocks: (page.ocrBlocks ?? []).map((block) => ({
      blockType: block.blockType,
      text: block.text,
      confidence: block.confidence,
      boundingBox: block.boundingBox,
      sourceAsset: block.sourceAsset
    })),
    assets: (page.ocrAssets ?? []).map((asset) => ({
      sourceAssetId: asset.sourceAssetId,
      fileName: asset.fileName,
      mimeType: asset.mimeType,
      boundingBox: asset.boundingBox,
      metadata: asset.rawJson
    }))
  };
}

function extractionMetadataValue(value: unknown, key: "audit" | "recovery") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return (value as Record<string, unknown>)[key] ?? null;
}

function blueprintAuditReconciled(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const audit = (value as Record<string, unknown>).audit;
  return Boolean(
    audit &&
      typeof audit === "object" &&
      !Array.isArray(audit) &&
      (audit as Record<string, unknown>).reconciled === true
  );
}

function definedValues(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function providerMetadataFromExtractionMetadata(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const providerMetadata = (value as Record<string, unknown>).providerMetadata;
  return providerMetadata === undefined ? undefined : providerMetadata;
}
