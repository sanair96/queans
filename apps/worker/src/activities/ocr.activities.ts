import { randomUUID } from "node:crypto";

import type { PaperIngestionWorkflowInput } from "@queans/core";
import { prisma } from "@queans/db";
import {
  loadMistralConfigFromEnv,
  loadR2ConfigFromEnv,
  maxR2PresignExpiresSeconds,
  MistralBatchProvider,
  MistralOcrProvider,
  parseMistralOcrResult,
  R2ObjectStore
} from "@queans/providers";
import type { OcrImage, OcrPage, OcrResult } from "@queans/providers";

import { toInputJson, toNullableInputJson } from "../json.js";
import {
  applyBatchDiscount,
  estimateMistralOcrCostUsd,
  formatCostDecimal,
  loadProviderPricing,
  upsertProviderRunCost
} from "./provider-cost.js";
import {
  assertBatchSucceeded,
  createProviderBatchJob,
  ensureRetryImportProviderBatchJob,
  markProviderBatchImported,
  markProviderBatchImportFailed,
  markProviderBatchImporting,
  ProviderBatchNotCompleteError,
  updateProviderBatchJobFromProvider
} from "./provider-batch-job.js";

export async function submitOcrBatch(input: PaperIngestionWorkflowInput) {
  const sourcePaper = await prisma.sourcePaper.findUnique({
    where: { id: input.sourcePaperId },
    include: { uploadObject: true }
  });

  if (!sourcePaper) {
    throw new Error(`Source paper ${input.sourcePaperId} not found`);
  }

  const objectStore = new R2ObjectStore(loadR2ConfigFromEnv(process.env));
  const documentUrl = await objectStore.createPresignedRead(sourcePaper.uploadObject.objectKey, maxR2PresignExpiresSeconds);
  const config = loadMistralConfigFromEnv(process.env);
  const batchProvider = new MistralBatchProvider(config);
  const inputFileId = await batchProvider.uploadBatchJsonl({
    fileName: `ocr-${input.ingestionRunId}.jsonl`,
    lines: [
      batchProvider.buildOcrBatchLine({
        customId: ocrCustomId(input.sourcePaperId),
        documentUrl
      })
    ]
  });
  const batchJob = await batchProvider.createBatchJob({
    inputFileId,
    endpoint: "/v1/ocr",
    model: config.ocrModel,
    metadata: {
      workflowRunId: input.ingestionRunId,
      sourcePaperId: input.sourcePaperId,
      operation: "ocr"
    }
  });
  const persisted = await createProviderBatchJob({
    workflowRunId: input.ingestionRunId,
    sourcePaperId: input.sourcePaperId,
    operation: "ocr",
    endpoint: "/v1/ocr",
    model: config.ocrModel,
    inputFileId,
    batchJob
  });

  return {
    providerBatchJobId: persisted.id,
    providerJobId: batchJob.id,
    inputFileId,
    model: config.ocrModel
  };
}

export async function importOcrBatchAndPersist(input: PaperIngestionWorkflowInput) {
  const batchJobRecord = await prisma.providerBatchJob.findFirst({
    where: {
      workflowRunId: input.ingestionRunId,
      sourcePaperId: input.sourcePaperId,
      operation: "ocr"
    },
    orderBy: { createdAt: "desc" }
  });

  if (!batchJobRecord?.providerJobId) {
    throw new Error(`No OCR batch job found for ingestion run ${input.ingestionRunId}`);
  }

  try {
    const batchProvider = new MistralBatchProvider(loadMistralConfigFromEnv(process.env));
    const remoteBatchJob = await batchProvider.retrieveBatchJob(batchJobRecord.providerJobId);
    await updateProviderBatchJobFromProvider({
      id: batchJobRecord.id,
      batchJob: remoteBatchJob
    });
    assertBatchSucceeded(remoteBatchJob);
    const outputFileId = requiredOutputFileId(remoteBatchJob.outputFile, remoteBatchJob.id);
    await markProviderBatchImporting(batchJobRecord.id);
    const resultLines = await batchProvider.downloadBatchResultFile(outputFileId);
    const resultLine = resultLines.find((line) => line.customId === ocrCustomId(input.sourcePaperId));
    if (!resultLine) {
      throw new Error(`OCR batch result for source paper ${input.sourcePaperId} was not found`);
    }
    if (resultLine.error || resultLine.statusCode !== 200) {
      throw new Error(`OCR batch result failed for source paper ${input.sourcePaperId}: ${JSON.stringify(resultLine.error)}`);
    }

    const result = parseMistralOcrResult(resultLine.body);
    await persistOcrResult(input, result, { batchJobId: remoteBatchJob.id, outputFileId });
    await markProviderBatchImported({
      id: batchJobRecord.id,
      output: {
        providerJobId: remoteBatchJob.id,
        outputFileId,
        resultLine: resultLine.rawJson
      }
    });

    return {
      pagesProcessed: result.pages.length,
      model: result.model,
      providerBatchJobId: batchJobRecord.id,
      providerJobId: remoteBatchJob.id
    };
  } catch (error) {
    if (error instanceof ProviderBatchNotCompleteError) {
      throw error;
    }
    await markProviderBatchImportFailed({
      id: batchJobRecord.id,
      error
    });
    throw error;
  }
}

export async function retryOcrBatchImport(input: PaperIngestionWorkflowInput, providerBatchJobId: string) {
  await ensureRetryImportProviderBatchJob({
    workflowRunId: input.ingestionRunId,
    sourcePaperId: input.sourcePaperId,
    retryOfBatchJobId: providerBatchJobId,
    operation: "ocr"
  });
  return importOcrBatchAndPersist(input);
}

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
  await persistOcrResult(input, result, { synchronous: true });

  return {
    pagesProcessed: result.pages.length,
    model: result.model
  };
}

async function persistOcrResult(
  input: PaperIngestionWorkflowInput,
  result: OcrResult,
  usageMetadata: Record<string, unknown>
) {
  const objectStore = new R2ObjectStore(loadR2ConfigFromEnv(process.env));
  const pages = await pagesWithStoredImages({
    sourcePaperId: input.sourcePaperId,
    pages: result.pages,
    objectStore
  });
  const pageCount = result.usage.pagesProcessed ?? pages.length;
  const pricing = loadProviderPricing(process.env);
  const baseEstimatedCostUsd = estimateMistralOcrCostUsd(pageCount, pricing);
  const estimatedCostUsd =
    usageMetadata.synchronous === true ? baseEstimatedCostUsd : applyBatchDiscount(baseEstimatedCostUsd, pricing);

  await prisma.$transaction(async (tx) => {
    await tx.sourcePaper.update({
      where: { id: input.sourcePaperId },
      data: {
        status: "PROCESSING",
        pageCount: pages.length
      }
    });

    for (const page of pages) {
      const ocrPage = await tx.ocrPage.upsert({
        where: {
          sourcePaperId_provider_pageNumber: {
            sourcePaperId: input.sourcePaperId,
            provider: result.provider,
            pageNumber: page.pageNumber
          }
        },
        create: {
          sourcePaperId: input.sourcePaperId,
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

    await upsertProviderRunCost(tx, {
      workflowRunId: input.ingestionRunId,
      provider: result.provider,
      model: result.model,
      operation: "ocr",
      pageCount,
      estimatedCostUsd: formatCostDecimal(estimatedCostUsd),
      rawUsage: toInputJson({
        ...result.usage,
        ...usageMetadata,
        batchDiscountRatio: usageMetadata.synchronous === true ? 1 : pricing.mistralBatchDiscountRatio
      })
    });
  });
}

async function pagesWithStoredImages(input: {
  sourcePaperId: string;
  pages: OcrPage[];
  objectStore: R2ObjectStore;
}): Promise<OcrPage[]> {
  const storedAssetByImageId = new Map<string, Record<string, unknown>>();
  for (const page of input.pages) {
    for (const image of page.images) {
      const asset = await storeOcrImage({
        sourcePaperId: input.sourcePaperId,
        pageNumber: page.pageNumber,
        image,
        objectStore: input.objectStore
      });
      storedAssetByImageId.set(image.id, asset);
    }
  }

  return input.pages.map((page) => ({
    ...page,
    images: [],
    blocks: page.blocks.map((block) => {
      const imageId = imageIdFromSourceAsset(block.sourceAsset);
      if (!imageId) {
        return block;
      }

      return {
        ...block,
        sourceAsset: storedAssetByImageId.get(imageId) ?? block.sourceAsset
      };
    })
  }));
}

async function storeOcrImage(input: {
  sourcePaperId: string;
  pageNumber: number;
  image: OcrImage;
  objectStore: R2ObjectStore;
}) {
  const objectKey = `ocr-assets/${input.sourcePaperId}/page-${input.pageNumber}/${randomUUID()}-${input.image.fileName}`;
  const bytes = Uint8Array.from(Buffer.from(input.image.base64, "base64"));
  const stored = await input.objectStore.putObject({
    objectKey,
    body: bytes,
    contentType: input.image.mimeType
  });

  return {
    imageId: input.image.id,
    objectKey: stored.objectKey,
    fileName: input.image.fileName,
    mimeType: input.image.mimeType,
    byteSize: bytes.byteLength,
    etag: stored.etag ?? null,
    boundingBox: input.image.boundingBox ?? null
  };
}

function imageIdFromSourceAsset(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const imageId = record.imageId ?? record.id;
  return typeof imageId === "string" ? imageId : undefined;
}

function ocrCustomId(sourcePaperId: string) {
  return `sourcePaper:${sourcePaperId}`;
}

function requiredOutputFileId(value: string | undefined, providerJobId: string) {
  if (!value) {
    throw new Error(`Mistral batch job ${providerJobId} is missing outputFile`);
  }

  return value;
}
