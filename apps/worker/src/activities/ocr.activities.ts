import type { PaperIngestionWorkflowInput } from "@queans/core";
import { prisma } from "@queans/db";
import { loadMistralConfigFromEnv, loadR2ConfigFromEnv, MistralOcrProvider, R2ObjectStore } from "@queans/providers";

import { toInputJson, toNullableInputJson } from "../json.js";
import { estimateMistralOcrCostUsd, formatCostDecimal, loadProviderPricing } from "./provider-cost.js";

export async function runOcrAndPersist(input: PaperIngestionWorkflowInput) {
  const sourcePaper = await prisma.sourcePaper.findUnique({
    where: { id: input.sourcePaperId },
    include: { uploadObject: true }
  });

  if (!sourcePaper) {
    throw new Error(`Source paper ${input.sourcePaperId} not found`);
  }

  const objectStore = new R2ObjectStore(loadR2ConfigFromEnv(process.env));
  const documentUrl = await objectStore.createPresignedRead(sourcePaper.uploadObject.objectKey);
  const ocrProvider = new MistralOcrProvider(loadMistralConfigFromEnv(process.env));
  const result = await ocrProvider.processDocumentUrl(documentUrl);
  const pageCount = result.usage.pagesProcessed ?? result.pages.length;
  const estimatedCostUsd = estimateMistralOcrCostUsd(pageCount, loadProviderPricing(process.env));

  await prisma.$transaction(async (tx) => {
    await tx.sourcePaper.update({
      where: { id: sourcePaper.id },
      data: {
        status: "PROCESSING",
        pageCount: result.pages.length
      }
    });

    for (const page of result.pages) {
      const ocrPage = await tx.ocrPage.upsert({
        where: {
          sourcePaperId_provider_pageNumber: {
            sourcePaperId: sourcePaper.id,
            provider: result.provider,
            pageNumber: page.pageNumber
          }
        },
        create: {
          sourcePaperId: sourcePaper.id,
          provider: result.provider,
          pageNumber: page.pageNumber,
          markdown: page.markdown,
          plainText: page.plainText ?? null,
          averageConfidence: page.averageConfidence ?? null,
          minimumConfidence: page.minimumConfidence ?? null,
          width: page.width ?? null,
          height: page.height ?? null,
          dpi: page.dpi ?? null,
          rawJson: toInputJson(page.rawJson),
          ocrBlocks: {
            create: page.blocks.map((block) => ({
              blockType: block.blockType,
              text: block.text,
              confidence: block.confidence ?? null,
              boundingBox: toNullableInputJson(block.boundingBox),
              sourceAsset: toNullableInputJson(block.sourceAsset),
              rawJson: toNullableInputJson(block.rawJson)
            }))
          }
        },
        update: {
          markdown: page.markdown,
          plainText: page.plainText ?? null,
          averageConfidence: page.averageConfidence ?? null,
          minimumConfidence: page.minimumConfidence ?? null,
          width: page.width ?? null,
          height: page.height ?? null,
          dpi: page.dpi ?? null,
          rawJson: toInputJson(page.rawJson)
        }
      });

      await tx.ocrBlock.deleteMany({ where: { ocrPageId: ocrPage.id } });
      await tx.ocrBlock.createMany({
        data: page.blocks.map((block) => ({
          ocrPageId: ocrPage.id,
          blockType: block.blockType,
          text: block.text,
          confidence: block.confidence ?? null,
          boundingBox: toNullableInputJson(block.boundingBox),
          sourceAsset: toNullableInputJson(block.sourceAsset),
          rawJson: toNullableInputJson(block.rawJson)
        }))
      });
    }

    await tx.providerRunCost.create({
      data: {
        workflowRunId: input.ingestionRunId,
        provider: result.provider,
        model: result.model,
        operation: "ocr",
        pageCount,
        estimatedCostUsd: formatCostDecimal(estimatedCostUsd),
        rawUsage: toInputJson(result.usage)
      }
    });
  });

  return {
    pagesProcessed: result.pages.length,
    model: result.model
  };
}
