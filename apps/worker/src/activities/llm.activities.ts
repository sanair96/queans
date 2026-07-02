import { createHash } from "node:crypto";

import type { PaperIngestionWorkflowInput } from "@queans/core";
import { CandidateStatus, prisma, Prisma, QuestionType, ReviewReason } from "@queans/db";
import {
  loadMistralConfigFromEnv,
  loadR2ConfigFromEnv,
  maxR2PresignExpiresSeconds,
  MistralBatchProvider,
  parseMistralChatCandidateBatchBody,
  parseMistralExtractionContent,
  parseMistralSolvingContent,
  R2ObjectStore
} from "@queans/providers";
import { createQuestionExtractorFromEnv } from "@queans/providers";
import type { ExtractedQuestionCandidate, OcrPage, QuestionExtractionResult } from "@queans/providers";

import { toInputJson } from "../json.js";
import {
  applyBatchDiscount,
  estimateMistralExtractorCostUsd,
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
import { normalizeTaxonomyName } from "./taxonomy.js";

export async function submitSegmentationBatch(input: PaperIngestionWorkflowInput) {
  const pages = await loadOcrPages(input.sourcePaperId);
  const config = loadMistralConfigFromEnv(process.env);
  const batchProvider = new MistralBatchProvider(config);
  const inputFileId = await batchProvider.uploadBatchJsonl({
    fileName: `question-segmentation-${input.ingestionRunId}.jsonl`,
    lines: [
      batchProvider.buildSegmentationBatchLine({
        customId: sourcePaperCustomId(input.sourcePaperId),
        pages
      })
    ]
  });
  const batchJob = await batchProvider.createBatchJob({
    inputFileId,
    endpoint: "/v1/chat/completions",
    model: config.segmentationModel,
    metadata: {
      workflowRunId: input.ingestionRunId,
      sourcePaperId: input.sourcePaperId,
      operation: "question_segmentation"
    }
  });
  const persisted = await createProviderBatchJob({
    workflowRunId: input.ingestionRunId,
    sourcePaperId: input.sourcePaperId,
    operation: "question_segmentation",
    endpoint: "/v1/chat/completions",
    model: config.segmentationModel,
    inputFileId,
    batchJob
  });

  return {
    providerBatchJobId: persisted.id,
    providerJobId: batchJob.id,
    inputFileId,
    model: config.segmentationModel
  };
}

export async function importSegmentationBatchAndPersist(input: PaperIngestionWorkflowInput) {
  const batchJobRecord = await latestBatchJob(input, "question_segmentation");

  try {
    const config = loadMistralConfigFromEnv(process.env);
    const batchProvider = new MistralBatchProvider(config);
    const remoteBatchJob = await batchProvider.retrieveBatchJob(requiredProviderJobId(batchJobRecord.providerJobId));
    await updateProviderBatchJobFromProvider({ id: batchJobRecord.id, batchJob: remoteBatchJob });
    assertBatchSucceeded(remoteBatchJob);
    const outputFileId = requiredOutputFileId(remoteBatchJob.outputFile, remoteBatchJob.id);
    await markProviderBatchImporting(batchJobRecord.id);
    const resultLines = await batchProvider.downloadBatchResultFile(outputFileId);
    const resultLine = resultLines.find((line) => line.customId === sourcePaperCustomId(input.sourcePaperId));
    if (!resultLine) {
      throw new Error(`Segmentation batch result for source paper ${input.sourcePaperId} was not found`);
    }
    if (resultLine.error || resultLine.statusCode !== 200) {
      throw new Error(`Segmentation batch result failed for source paper ${input.sourcePaperId}: ${JSON.stringify(resultLine.error)}`);
    }

    const chat = parseMistralChatCandidateBatchBody(resultLine.body);
    const candidates = parseMistralExtractionContent(chat.content);
    const summary = await persistExtractedCandidates(input, {
      provider: "mistral",
      model: config.segmentationModel,
      candidates,
      rawJson: resultLine.rawJson,
      usage: chat.usage
    });
    await recordLlmBatchCost({
      input,
      model: config.segmentationModel,
      operation: "question_segmentation",
      usage: chat.usage,
      batchMetadata: {
        providerJobId: remoteBatchJob.id,
        outputFileId
      }
    });
    await markProviderBatchImported({
      id: batchJobRecord.id,
      output: {
        providerJobId: remoteBatchJob.id,
        outputFileId,
        resultLine: resultLine.rawJson
      }
    });

    return {
      ...summary,
      model: config.segmentationModel,
      providerBatchJobId: batchJobRecord.id,
      providerJobId: remoteBatchJob.id
    };
  } catch (error) {
    if (error instanceof ProviderBatchNotCompleteError) {
      throw error;
    }
    await markProviderBatchImportFailed({ id: batchJobRecord.id, error });
    throw error;
  }
}

export async function submitSolvingBatch(input: PaperIngestionWorkflowInput) {
  const candidates = await prisma.questionCandidate.findMany({
    where: {
      sourcePaperId: input.sourcePaperId,
      approvedQuestionId: null,
      reviewStatus: { in: [CandidateStatus.EXTRACTED, CandidateStatus.NEEDS_REVIEW] }
    },
    orderBy: [{ sourcePageStart: "asc" }, { pageNumber: "asc" }, { questionNumber: "asc" }, { createdAt: "asc" }]
  });

  if (candidates.length === 0) {
    return {
      skipped: true,
      reason: "NO_CANDIDATES_TO_SOLVE"
    };
  }

  const config = loadMistralConfigFromEnv(process.env);
  const batchProvider = new MistralBatchProvider(config);
  const objectStore = new R2ObjectStore(loadR2ConfigFromEnv(process.env));
  const lines = [];
  for (const candidate of candidates) {
    lines.push(
      batchProvider.buildSolvingBatchLine({
        customId: candidateCustomId(candidate.id),
        candidate: candidateToExtracted(candidate),
        imageUrls: await signedImageUrlsForCandidate(candidate, objectStore)
      })
    );
  }

  const inputFileId = await batchProvider.uploadBatchJsonl({
    fileName: `question-solving-${input.ingestionRunId}.jsonl`,
    lines
  });
  const batchJob = await batchProvider.createBatchJob({
    inputFileId,
    endpoint: "/v1/chat/completions",
    model: config.solverModel,
    metadata: {
      workflowRunId: input.ingestionRunId,
      sourcePaperId: input.sourcePaperId,
      operation: "question_solving"
    }
  });
  const persisted = await createProviderBatchJob({
    workflowRunId: input.ingestionRunId,
    sourcePaperId: input.sourcePaperId,
    operation: "question_solving",
    endpoint: "/v1/chat/completions",
    model: config.solverModel,
    inputFileId,
    batchJob
  });

  return {
    providerBatchJobId: persisted.id,
    providerJobId: batchJob.id,
    inputFileId,
    candidatesSubmitted: candidates.length,
    model: config.solverModel
  };
}

export async function importSolvingBatchAndPersist(input: PaperIngestionWorkflowInput) {
  const batchJobRecord = await latestBatchJob(input, "question_solving");

  try {
    const config = loadMistralConfigFromEnv(process.env);
    const batchProvider = new MistralBatchProvider(config);
    const remoteBatchJob = await batchProvider.retrieveBatchJob(requiredProviderJobId(batchJobRecord.providerJobId));
    await updateProviderBatchJobFromProvider({ id: batchJobRecord.id, batchJob: remoteBatchJob });
    assertBatchSucceeded(remoteBatchJob);
    const outputFileId = requiredOutputFileId(remoteBatchJob.outputFile, remoteBatchJob.id);
    await markProviderBatchImporting(batchJobRecord.id);
    const resultLines = await batchProvider.downloadBatchResultFile(outputFileId);

    let candidatesSolved = 0;
    let candidatesFailed = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    for (const resultLine of resultLines) {
      const candidateId = resultLine.customId.replace(/^candidate:/u, "");
      if (!candidateId || candidateId === resultLine.customId) {
        candidatesFailed += 1;
        continue;
      }
      if (resultLine.error || resultLine.statusCode !== 200) {
        await markCandidateSolveFailed(candidateId, resultLine.error);
        candidatesFailed += 1;
        continue;
      }

      const chat = parseMistralChatCandidateBatchBody(resultLine.body);
      promptTokens += chat.usage.promptTokens ?? 0;
      completionTokens += chat.usage.completionTokens ?? 0;
      await updateSolvedCandidate(candidateId, parseMistralSolvingContent(chat.content));
      candidatesSolved += 1;
    }

    const usage = {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens
    };
    await recordLlmBatchCost({
      input,
      model: config.solverModel,
      operation: "question_solving",
      usage,
      batchMetadata: {
        providerJobId: remoteBatchJob.id,
        outputFileId
      }
    });
    await markProviderBatchImported({
      id: batchJobRecord.id,
      output: {
        providerJobId: remoteBatchJob.id,
        outputFileId,
        resultCount: resultLines.length,
        candidatesSolved,
        candidatesFailed
      }
    });

    return {
      candidatesSolved,
      candidatesFailed,
      model: config.solverModel,
      providerBatchJobId: batchJobRecord.id,
      providerJobId: remoteBatchJob.id
    };
  } catch (error) {
    if (error instanceof ProviderBatchNotCompleteError) {
      throw error;
    }
    await markProviderBatchImportFailed({ id: batchJobRecord.id, error });
    throw error;
  }
}

export async function retryLlmBatchImport(input: PaperIngestionWorkflowInput, providerBatchJobId: string) {
  const batchJobRecord = await prisma.providerBatchJob.findUnique({
    where: { id: providerBatchJobId },
    select: {
      sourcePaperId: true,
      operation: true
    }
  });

  if (!batchJobRecord?.sourcePaperId) {
    throw new Error(`Provider batch job ${providerBatchJobId} cannot be retried for LLM import`);
  }

  if (batchJobRecord.operation === "question_segmentation") {
    await ensureRetryImportProviderBatchJob({
      workflowRunId: input.ingestionRunId,
      sourcePaperId: input.sourcePaperId,
      retryOfBatchJobId: providerBatchJobId,
      operation: "question_segmentation"
    });
    return importSegmentationBatchAndPersist(input);
  }
  if (batchJobRecord.operation === "question_solving") {
    await ensureRetryImportProviderBatchJob({
      workflowRunId: input.ingestionRunId,
      sourcePaperId: input.sourcePaperId,
      retryOfBatchJobId: providerBatchJobId,
      operation: "question_solving"
    });
    return importSolvingBatchAndPersist(input);
  }

  throw new Error(`Provider batch job ${providerBatchJobId} is not an LLM batch job`);
}

export async function extractQuestionsAndPersist(input: PaperIngestionWorkflowInput) {
  const pages = await loadOcrPages(input.sourcePaperId);
  const extractor = createQuestionExtractorFromEnv(process.env);
  const extraction = await extractor.extractFromPages(pages);
  const summary = await persistExtractedCandidates(input, extraction);
  await recordLlmBatchCost({
    input,
    model: extraction.model,
    operation: "question_extraction",
    usage: extraction.usage,
    batchMetadata: {
      synchronous: true
    }
  });

  return {
    ...summary,
    model: extraction.model
  };
}

export async function solveQuestionsAndPersist(input: PaperIngestionWorkflowInput) {
  const candidates = await prisma.questionCandidate.findMany({
    where: {
      sourcePaperId: input.sourcePaperId,
      approvedQuestionId: null,
      reviewStatus: { in: [CandidateStatus.EXTRACTED, CandidateStatus.NEEDS_REVIEW] }
    },
    orderBy: [{ sourcePageStart: "asc" }, { pageNumber: "asc" }, { questionNumber: "asc" }, { createdAt: "asc" }]
  });

  if (candidates.length === 0) {
    return {
      skipped: true,
      reason: "NO_CANDIDATES_TO_SOLVE"
    };
  }

  const extractor = createQuestionExtractorFromEnv(process.env);
  const objectStore = new R2ObjectStore(loadR2ConfigFromEnv(process.env));
  let candidatesSolved = 0;
  let candidatesFailed = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let model: string | undefined;

  for (const candidate of candidates) {
    try {
      const solved = await extractor.solveCandidate(
        candidateToExtracted(candidate),
        await signedImageUrlsForCandidate(candidate, objectStore)
      );
      model = solved.model;
      promptTokens += solved.usage.promptTokens ?? 0;
      completionTokens += solved.usage.completionTokens ?? 0;
      await updateSolvedCandidate(candidate.id, solved.candidate);
      candidatesSolved += 1;
    } catch (error) {
      await markCandidateSolveFailed(candidate.id, error);
      candidatesFailed += 1;
    }
  }

  const usage = {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens
  };
  const config = loadMistralConfigFromEnv(process.env);
  await recordLlmBatchCost({
    input,
    model: model ?? config.solverModel,
    operation: "question_solving",
    usage,
    batchMetadata: {
      synchronous: true,
      candidatesSubmitted: candidates.length,
      candidatesSolved,
      candidatesFailed
    }
  });

  return {
    candidatesSubmitted: candidates.length,
    candidatesSolved,
    candidatesFailed,
    model: model ?? config.solverModel
  };
}

async function persistExtractedCandidates(input: PaperIngestionWorkflowInput, extraction: QuestionExtractionResult) {
  let candidatesCreated = 0;
  let candidatesUpdated = 0;
  let committedCandidatesSkipped = 0;
  let terminalCandidatesSkipped = 0;

  await prisma.$transaction(async (tx) => {
    for (const candidate of extraction.candidates) {
      const taxonomy = await resolveCandidateTaxonomy(tx, candidate);
      const fingerprint = candidateFingerprint(candidate);
      const fieldConfidences = fieldConfidenceRows(candidate);
      const candidateData = candidatePersistenceData(candidate, taxonomy);
      const existingCandidate = await tx.questionCandidate.findUnique({
        where: {
          sourcePaperId_fingerprint: {
            sourcePaperId: input.sourcePaperId,
            fingerprint
          }
        },
        select: {
          id: true,
          approvedQuestionId: true,
          reviewStatus: true
        }
      });

      if (existingCandidate && shouldSkipExistingCandidateForExtraction(existingCandidate)) {
        if (existingCandidate.approvedQuestionId) {
          committedCandidatesSkipped += 1;
        } else {
          terminalCandidatesSkipped += 1;
        }
        continue;
      }

      if (existingCandidate) {
        await tx.questionCandidate.update({
          where: { id: existingCandidate.id },
          data: {
            fingerprint,
            ...candidateData
          }
        });
        await replaceFieldConfidences(tx, existingCandidate.id, fieldConfidences);
        candidatesUpdated += 1;
        continue;
      }

      const createdCandidate = await tx.questionCandidate.create({
        data:
          fieldConfidences.length > 0
            ? {
                sourcePaperId: input.sourcePaperId,
                fingerprint,
                ...candidateData,
                fieldConfidences: {
                  create: fieldConfidences
                }
              }
            : {
                sourcePaperId: input.sourcePaperId,
                fingerprint,
                ...candidateData
              },
        select: { id: true }
      });
      if (createdCandidate.id) {
        candidatesCreated += 1;
      }
    }
  });

  return {
    candidatesExtracted: extraction.candidates.length,
    candidatesCreated,
    candidatesUpdated,
    committedCandidatesSkipped,
    terminalCandidatesSkipped
  };
}

const preservedExtractionStatuses = [
  CandidateStatus.APPROVED,
  CandidateStatus.EDITED_AND_APPROVED,
  CandidateStatus.REJECTED,
  CandidateStatus.DUPLICATE,
  CandidateStatus.UNPROCESSABLE
] as const;

export function shouldSkipExistingCandidateForExtraction(candidate: {
  approvedQuestionId: string | null;
  reviewStatus: CandidateStatus;
}) {
  return (
    candidate.approvedQuestionId !== null ||
    preservedExtractionStatuses.some((status) => status === candidate.reviewStatus)
  );
}

export function candidateFingerprint(candidate: ExtractedQuestionCandidate) {
  const sourcePageStart = candidate.sourcePageStart ?? candidate.pageNumber ?? null;
  const sourcePageEnd = candidate.sourcePageEnd ?? candidate.sourcePageStart ?? candidate.pageNumber ?? null;
  const fingerprintBasis = [
    sourcePageStart,
    sourcePageEnd,
    normalizeFingerprintPart(candidate.sectionName),
    normalizeFingerprintPart(candidate.questionNumber),
    normalizeFingerprintPart(candidate.cleanedQuestionText)
  ];

  return createHash("sha256").update(JSON.stringify(fingerprintBasis)).digest("hex");
}

function normalizeFingerprintPart(value: string | undefined) {
  return value?.trim().toLowerCase().replace(/\s+/g, " ") || null;
}

async function updateSolvedCandidate(candidateId: string, candidate: ExtractedQuestionCandidate) {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.questionCandidate.findUnique({
      where: { id: candidateId },
      select: {
        id: true,
        approvedQuestionId: true,
        reviewStatus: true
      }
    });

    if (!existing || shouldSkipExistingCandidateForExtraction(existing)) {
      return;
    }

    const taxonomy = await resolveCandidateTaxonomy(tx, candidate);
    const fieldConfidences = fieldConfidenceRows(candidate);
    await tx.questionCandidate.update({
      where: { id: candidateId },
      data: candidatePersistenceData(candidate, taxonomy)
    });
    await replaceFieldConfidences(tx, candidateId, fieldConfidences);
  });
}

async function markCandidateSolveFailed(candidateId: string, error: unknown) {
  await prisma.questionCandidate.updateMany({
    where: {
      id: candidateId,
      reviewStatus: { in: [CandidateStatus.EXTRACTED, CandidateStatus.NEEDS_REVIEW] }
    },
    data: {
      reviewStatus: CandidateStatus.NEEDS_REVIEW,
      validationErrors: toInputJson(["VALIDATION_FAILED", "ANSWER_UNCERTAIN"]),
      extractedPayload: toInputJson({
        solveError: error
      })
    }
  });
}

function candidatePersistenceData(
  candidate: ExtractedQuestionCandidate,
  taxonomy: Awaited<ReturnType<typeof resolveCandidateTaxonomy>>
) {
  return {
    pageNumber: candidate.pageNumber ?? null,
    sourcePageStart: candidate.sourcePageStart ?? null,
    sourcePageEnd: candidate.sourcePageEnd ?? null,
    questionNumber: candidate.questionNumber ?? null,
    sectionName: candidate.sectionName ?? null,
    rawOcrText: candidate.rawOcrText,
    cleanedQuestionText: candidate.cleanedQuestionText,
    questionType: mapQuestionType(candidate.questionType),
    marks: candidate.marks ?? null,
    options: candidate.options === undefined ? Prisma.JsonNull : toInputJson(candidate.options),
    answerText: candidate.answerText ?? null,
    solutionText: candidate.solutionText ?? null,
    answerSourceType: candidate.answerSourceType,
    answerSourceBacked: candidate.answerSourceBacked,
    chapterId: taxonomy.chapterId,
    topicId: taxonomy.topicId,
    subtopicId: taxonomy.subtopicId,
    difficulty: candidate.difficulty ?? null,
    bloomLevel: candidate.bloomLevel ?? null,
    requiresDiagram: candidate.requiresDiagram,
    diagramAsset: candidate.diagramAsset === undefined ? Prisma.JsonNull : toInputJson(candidate.diagramAsset),
    extractedPayload: toInputJson(candidate),
    sourceEvidence: toInputJson(candidate.sourceEvidence),
    fieldConfidence: toInputJson(candidate.fieldConfidence),
    overallConfidence: candidate.overallConfidence,
    validationErrors: toInputJson(candidate.validationErrors),
    reviewStatus: candidate.validationErrors.length > 0 ? CandidateStatus.NEEDS_REVIEW : CandidateStatus.EXTRACTED
  };
}

function fieldConfidenceRows(candidate: ExtractedQuestionCandidate) {
  return Object.entries(candidate.fieldConfidence).map(([fieldName, confidence]) => ({
    fieldName,
    confidence,
    reasonCode: reasonForCandidateField(fieldName, candidate.validationErrors) ?? null
  }));
}

async function replaceFieldConfidences(
  tx: Prisma.TransactionClient,
  candidateId: string,
  fieldConfidences: ReturnType<typeof fieldConfidenceRows>
) {
  await tx.candidateFieldConfidence.deleteMany({ where: { candidateId } });
  if (fieldConfidences.length > 0) {
    await tx.candidateFieldConfidence.createMany({
      data: fieldConfidences.map((fieldConfidence) => ({
        candidateId,
        ...fieldConfidence
      }))
    });
  }
}

async function resolveCandidateTaxonomy(tx: Prisma.TransactionClient, candidate: ExtractedQuestionCandidate) {
  const chapterName = normalizeTaxonomyName(candidate.chapter);
  const topicName = normalizeTaxonomyName(candidate.topic);
  const subtopicName = normalizeTaxonomyName(candidate.subtopic);

  const chapterId = chapterName ? (await upsertChapter(tx, chapterName)).id : null;
  const topicId = topicName ? (await findOrCreateTopic(tx, topicName, chapterId)).id : null;
  const subtopicId = subtopicName ? (await findOrCreateSubtopic(tx, subtopicName, topicId)).id : null;

  return { chapterId, topicId, subtopicId };
}

async function upsertChapter(tx: Prisma.TransactionClient, name: string) {
  return tx.chapter.upsert({
    where: { name },
    update: {},
    create: { name },
    select: { id: true }
  });
}

async function findOrCreateTopic(tx: Prisma.TransactionClient, name: string, chapterId: string | null) {
  if (chapterId) {
    return tx.topic.upsert({
      where: {
        chapterId_name: {
          chapterId,
          name
        }
      },
      update: {},
      create: {
        chapterId,
        name
      },
      select: { id: true }
    });
  }

  const existing = await tx.topic.findFirst({
    where: {
      chapterId: null,
      name
    },
    select: { id: true }
  });

  return existing ?? tx.topic.create({ data: { name }, select: { id: true } });
}

async function findOrCreateSubtopic(tx: Prisma.TransactionClient, name: string, topicId: string | null) {
  if (topicId) {
    return tx.subtopic.upsert({
      where: {
        topicId_name: {
          topicId,
          name
        }
      },
      update: {},
      create: {
        topicId,
        name
      },
      select: { id: true }
    });
  }

  const existing = await tx.subtopic.findFirst({
    where: {
      topicId: null,
      name
    },
    select: { id: true }
  });

  return existing ?? tx.subtopic.create({ data: { name }, select: { id: true } });
}

function mapQuestionType(value: string) {
  const normalized = value.toLowerCase().replace(/[^a-z]/g, "_");
  switch (normalized) {
    case "mcq":
    case "multiple_choice":
      return QuestionType.MCQ;
    case "short_answer":
      return QuestionType.SHORT_ANSWER;
    case "long_answer":
      return QuestionType.LONG_ANSWER;
    case "numerical":
      return QuestionType.NUMERICAL;
    case "true_false":
      return QuestionType.TRUE_FALSE;
    case "fill_in_the_blank":
      return QuestionType.FILL_IN_THE_BLANK;
    case "matching":
      return QuestionType.MATCHING;
    case "diagram":
      return QuestionType.DIAGRAM;
    default:
      return QuestionType.UNKNOWN;
  }
}

function reasonForCandidateField(fieldName: string, reasons: ExtractedQuestionCandidate["validationErrors"]) {
  if (fieldName.includes("answer") && reasons.includes("LOW_ANSWER_CONFIDENCE")) {
    return ReviewReason.LOW_ANSWER_CONFIDENCE;
  }

  if (fieldName.includes("topic") && reasons.includes("LOW_TOPIC_CONFIDENCE")) {
    return ReviewReason.LOW_TOPIC_CONFIDENCE;
  }

  if (reasons.includes("LOW_FIELD_CONFIDENCE")) {
    return ReviewReason.LOW_FIELD_CONFIDENCE;
  }

  return undefined;
}

async function loadOcrPages(sourcePaperId: string): Promise<OcrPage[]> {
  const pages = await prisma.ocrPage.findMany({
    where: { sourcePaperId },
    orderBy: { pageNumber: "asc" }
  });

  if (pages.length === 0) {
    throw new Error(`No OCR pages found for source paper ${sourcePaperId}`);
  }

  return pages.map((page) => ({
    pageNumber: page.pageNumber,
    markdown: page.markdown,
    plainText: page.plainText ?? undefined,
    averageConfidence: page.averageConfidence ?? undefined,
    minimumConfidence: page.minimumConfidence ?? undefined,
    width: page.width ?? undefined,
    height: page.height ?? undefined,
    dpi: page.dpi ?? undefined,
    rawJson: page.rawJson,
    blocks: [],
    images: []
  }));
}

async function latestBatchJob(input: PaperIngestionWorkflowInput, operation: "question_segmentation" | "question_solving") {
  const batchJobRecord = await prisma.providerBatchJob.findFirst({
    where: {
      workflowRunId: input.ingestionRunId,
      sourcePaperId: input.sourcePaperId,
      operation
    },
    orderBy: { createdAt: "desc" }
  });

  if (!batchJobRecord?.providerJobId) {
    throw new Error(`No ${operation} batch job found for ingestion run ${input.ingestionRunId}`);
  }

  return batchJobRecord;
}

function requiredProviderJobId(value: string | null) {
  if (!value) {
    throw new Error("Provider batch job is missing providerJobId");
  }

  return value;
}

function requiredOutputFileId(value: string | undefined, providerJobId: string) {
  if (!value) {
    throw new Error(`Mistral batch job ${providerJobId} is missing outputFile`);
  }

  return value;
}

async function recordLlmBatchCost(input: {
  input: PaperIngestionWorkflowInput;
  model: string;
  operation: string;
  usage: {
    promptTokens?: number | undefined;
    completionTokens?: number | undefined;
    totalTokens?: number | undefined;
  };
  batchMetadata: Record<string, unknown>;
}) {
  const pricing = loadProviderPricing(process.env);
  const baseCost = estimateMistralExtractorCostUsd(input.usage, pricing);
  const estimatedCostUsd =
    input.batchMetadata.synchronous === true ? baseCost : applyBatchDiscount(baseCost, pricing);

  await prisma.$transaction(async (tx) => {
    await upsertProviderRunCost(tx, {
      workflowRunId: input.input.ingestionRunId,
      provider: "mistral",
      model: input.model,
      operation: input.operation,
      inputTokenCount: input.usage.promptTokens ?? null,
      outputTokenCount: input.usage.completionTokens ?? null,
      estimatedCostUsd: formatCostDecimal(estimatedCostUsd),
      rawUsage: toInputJson({
        ...input.usage,
        ...input.batchMetadata,
        batchDiscountRatio: input.batchMetadata.synchronous === true ? 1 : pricing.mistralBatchDiscountRatio
      })
    });
  });
}

function candidateToExtracted(
  candidate: Awaited<ReturnType<typeof prisma.questionCandidate.findMany>>[number]
): ExtractedQuestionCandidate {
  return {
    questionNumber: candidate.questionNumber ?? undefined,
    sectionName: candidate.sectionName ?? undefined,
    pageNumber: candidate.pageNumber ?? undefined,
    sourcePageStart: candidate.sourcePageStart ?? undefined,
    sourcePageEnd: candidate.sourcePageEnd ?? undefined,
    rawOcrText: candidate.rawOcrText,
    cleanedQuestionText: candidate.cleanedQuestionText,
    questionType: candidate.questionType,
    marks: candidate.marks ?? undefined,
    options: candidate.options === null ? undefined : candidate.options,
    answerText: candidate.answerText ?? undefined,
    solutionText: candidate.solutionText ?? undefined,
    answerSourceType: candidate.answerSourceType === "HUMAN_VERIFIED" ? "SOURCE_KEY" : candidate.answerSourceType,
    answerSourceBacked: candidate.answerSourceBacked,
    difficulty: candidate.difficulty ?? undefined,
    bloomLevel: candidate.bloomLevel ?? undefined,
    requiresDiagram: candidate.requiresDiagram,
    diagramAsset: candidate.diagramAsset === null ? undefined : candidate.diagramAsset,
    fieldConfidence: confidenceRecord(candidate.fieldConfidence),
    overallConfidence: candidate.overallConfidence,
    validationErrors: jsonStringArray(candidate.validationErrors),
    sourceEvidence: candidate.sourceEvidence
  };
}

async function signedImageUrlsForCandidate(
  candidate: Awaited<ReturnType<typeof prisma.questionCandidate.findMany>>[number],
  objectStore: R2ObjectStore
) {
  const sourcePageStart = candidate.sourcePageStart ?? candidate.pageNumber;
  const sourcePageEnd = candidate.sourcePageEnd ?? sourcePageStart;
  if (!sourcePageStart || !sourcePageEnd) {
    return [];
  }

  const blocks = await prisma.ocrBlock.findMany({
    where: {
      blockType: "image",
      ocrPage: {
        sourcePaperId: candidate.sourcePaperId,
        pageNumber: {
          gte: sourcePageStart,
          lte: sourcePageEnd
        }
      }
    },
    include: {
      ocrPage: {
        select: {
          pageNumber: true
        }
      }
    },
    orderBy: { createdAt: "asc" },
    take: 8
  });

  const imageUrls = [];
  for (const block of blocks) {
    const objectKey = objectKeyFromSourceAsset(block.sourceAsset);
    if (!objectKey) {
      continue;
    }
    imageUrls.push({
      label: `page ${block.ocrPage.pageNumber} ${block.text}`,
      url: await objectStore.createPresignedRead(objectKey, maxR2PresignExpiresSeconds)
    });
  }

  return imageUrls;
}

function objectKeyFromSourceAsset(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  return typeof record.objectKey === "string" ? record.objectKey : undefined;
}

function sourcePaperCustomId(sourcePaperId: string) {
  return `sourcePaper:${sourcePaperId}`;
}

function candidateCustomId(candidateId: string) {
  return `candidate:${candidateId}`;
}

function confidenceRecord(value: Prisma.JsonValue): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const entries = Object.entries(value)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .map(([fieldName, confidence]) => [fieldName, confidence] as const);

  return Object.fromEntries(entries);
}

function jsonStringArray(value: Prisma.JsonValue) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
