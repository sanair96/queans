import type { BlueprintIngestionWorkflowInput } from "@queans/core";
import { Prisma, prisma } from "@queans/db";
import {
  loadMistralConfigFromEnv,
  loadR2ConfigFromEnv,
  maxR2PresignExpiresSeconds,
  MistralBlueprintLanguageAnalyzer,
  MistralOcrProvider,
  R2ObjectStore
} from "@queans/providers";

import { analyzeBlueprintOcrPages, plainTextFromMarkdown } from "./blueprint-analysis.js";
import { toInputJson } from "../json.js";

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
        markdownText: page.markdown,
        plainText: page.plainText ?? plainTextFromMarkdown(page.markdown),
        ocrConfidence: page.averageConfidence ?? null,
        providerMetadata: toInputJson({
          provider: result.provider,
          model: result.model,
          page: page.rawJson ?? null,
          usage: result.usage
        })
      },
      update: {
        markdownText: page.markdown,
        plainText: page.plainText ?? plainTextFromMarkdown(page.markdown),
        ocrConfidence: page.averageConfidence ?? null,
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
        languageDetectionMetadata: toInputJson(analysis.languageAnalysis)
      }
    });
  });
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
      currentStep: "ocr_document"
    }
  });
  if (claimed.count === 0) {
    return { started: false };
  }

  await prisma.$transaction([
    prisma.blueprintDocument.updateMany({
      where: {
        id: input.blueprintDocumentId,
        status: { in: ["QUEUED", "PROCESSING"] }
      },
      data: { status: "PROCESSING" }
    }),
    prisma.workflowEvent.create({
      data: {
        workflowRunId: input.workflowRunId,
        eventType: "BLUEPRINT_PROCESSING_STARTED",
        eventPayload: { blueprintDocumentId: input.blueprintDocumentId }
      }
    })
  ]);

  return { started: true };
}

export async function completeBlueprintWorkflow(input: BlueprintIngestionWorkflowInput) {
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
        draftRulesJson: { not: Prisma.JsonNull }
      },
      data: { status: "READY_FOR_APPROVAL" }
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

export async function failBlueprintWorkflow(input: BlueprintIngestionWorkflowInput) {
  const claimed = await prisma.workflowRun.updateMany({
    where: {
      id: input.workflowRunId,
      workflowType: "BLUEPRINT_INGESTION",
      blueprintDocumentId: input.blueprintDocumentId,
      status: { in: ["PENDING", "RUNNING"] }
    },
    data: {
      status: "FAILED",
      errorPayload: { code: "BLUEPRINT_WORKFLOW_FAILED" },
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
        extractionError: "Blueprint ingestion workflow failed."
      }
    }),
    prisma.workflowEvent.create({
      data: {
        workflowRunId: input.workflowRunId,
        eventType: "BLUEPRINT_WORKFLOW_FAILED",
        eventPayload: { blueprintDocumentId: input.blueprintDocumentId }
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
