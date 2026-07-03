import { createHash } from "node:crypto";

import type { PaperIngestionWorkflowInput } from "@queans/core";
import { CandidateStatus, prisma, Prisma, QuestionType, ReviewReason } from "@queans/db";
import {
  loadMistralConfigFromEnv,
  loadR2ConfigFromEnv,
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
      reviewStatus: { in: [CandidateStatus.EXTRACTED, CandidateStatus.NEEDS_REVIEW] },
      answerText: null
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
  const extractor = createQuestionExtractorFromEnv(process.env);
  const objectStore = new R2ObjectStore(loadR2ConfigFromEnv(process.env));
  const solverRequestIntervalMs = solverRequestIntervalFromEnv(process.env);
  const solverConcurrency = solverConcurrencyFromEnv(process.env);
  let candidatesSubmitted = 0;
  let candidatesSolved = 0;
  let candidatesFailed = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let model: string | undefined;

  for (let pass = 0; pass < 3; pass += 1) {
    const candidates = await unsolvedQuestionCandidates(input.sourcePaperId);
    if (candidates.length === 0) {
      break;
    }

    const outcomes = await mapWithConcurrency(candidates, solverConcurrency, async (candidate, index) =>
      solveCandidateAndPersist({
        extractor,
        objectStore,
        candidate,
        delayMs: solverConcurrency === 1 && index > 0 ? solverRequestIntervalMs : 0
      })
    );
    candidatesSubmitted += candidates.length;
    candidatesSolved += outcomes.filter((outcome) => outcome.solved).length;
    candidatesFailed += outcomes.filter((outcome) => !outcome.solved).length;
    promptTokens += outcomes.reduce((total, outcome) => total + (outcome.promptTokens ?? 0), 0);
    completionTokens += outcomes.reduce((total, outcome) => total + (outcome.completionTokens ?? 0), 0);
    model ??= outcomes.find((outcome) => outcome.model)?.model;
    if (!outcomes.some((outcome) => outcome.splitCreated)) {
      break;
    }
  }

  if (candidatesSubmitted === 0) {
    return {
      skipped: true,
      reason: "NO_CANDIDATES_TO_SOLVE"
    };
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
      candidatesSubmitted,
      candidatesSolved,
      candidatesFailed,
      solverConcurrency
    }
  });

  return {
    candidatesSubmitted,
    candidatesSolved,
    candidatesFailed,
    model: model ?? config.solverModel
  };
}

function unsolvedQuestionCandidates(sourcePaperId: string) {
  return prisma.questionCandidate.findMany({
    where: {
      sourcePaperId,
      approvedQuestionId: null,
      reviewStatus: { in: [CandidateStatus.EXTRACTED, CandidateStatus.NEEDS_REVIEW] },
      answerText: null
    },
    orderBy: [{ sourcePageStart: "asc" }, { pageNumber: "asc" }, { questionNumber: "asc" }, { createdAt: "asc" }]
  }).then((candidates) =>
    candidates.filter((candidate) => !jsonStringArray(candidate.validationErrors).includes("VALIDATION_FAILED"))
  );
}

async function solveCandidateAndPersist(input: {
  extractor: ReturnType<typeof createQuestionExtractorFromEnv>;
  objectStore: R2ObjectStore;
  candidate: Awaited<ReturnType<typeof prisma.questionCandidate.findMany>>[number];
  delayMs: number;
}) {
  try {
    if (input.delayMs > 0) {
      await sleep(input.delayMs);
    }
    const solved = await solveCandidateWithRetry({
      extractor: input.extractor,
      candidate: candidateToExtracted(input.candidate),
      imageUrls: await signedImageUrlsForCandidate(input.candidate, input.objectStore)
    });
    const splitCreated = await updateSolvedCandidate(input.candidate.id, solved.candidate);
    return {
      solved: true,
      splitCreated,
      model: solved.model,
      promptTokens: solved.usage.promptTokens,
      completionTokens: solved.usage.completionTokens
    };
  } catch (error) {
    await markCandidateSolveFailed(input.candidate.id, error);
    return {
      solved: false,
      splitCreated: false
    };
  }
}

async function persistExtractedCandidates(input: PaperIngestionWorkflowInput, extraction: QuestionExtractionResult) {
  let candidatesCreated = 0;
  let candidatesUpdated = 0;
  let committedCandidatesSkipped = 0;
  let terminalCandidatesSkipped = 0;

  await prisma.$transaction(async (tx) => {
    for (const extractedCandidate of extraction.candidates) {
      const candidates = expandExtractedCandidate(hydrateCandidateFromEvidence(extractedCandidate));
      for (const candidate of candidates) {
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

function expandExtractedCandidate(candidate: ExtractedQuestionCandidate) {
  if (isNestedDetailCandidate(candidate)) {
    return [];
  }

  const numberedListCandidates = splitNumberedListCandidate(candidate);
  if (numberedListCandidates.length > 0) {
    return numberedListCandidates.flatMap((numberedCandidate) => {
      const textSubquestionCandidates = splitTextSubquestionCandidate(numberedCandidate);
      return textSubquestionCandidates.length > 0 ? textSubquestionCandidates : [numberedCandidate];
    });
  }

  const textSubquestionCandidates = splitTextSubquestionCandidate(candidate);
  return textSubquestionCandidates.length > 0 ? textSubquestionCandidates : [candidate];
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
    candidate.questionNumber ? null : normalizeFingerprintPart(candidate.cleanedQuestionText)
  ];

  return createHash("sha256").update(JSON.stringify(fingerprintBasis)).digest("hex");
}

function normalizeFingerprintPart(value: string | undefined) {
  return value?.trim().toLowerCase().replace(/\s+/g, " ") || null;
}

async function updateSolvedCandidate(candidateId: string, candidate: ExtractedQuestionCandidate) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.questionCandidate.findUnique({
      where: { id: candidateId }
    });

    if (!existing || shouldSkipExistingCandidateForExtraction(existing)) {
      return false;
    }

    const mergedCandidate = hydrateCandidateFromEvidence(mergeSolvedCandidate(candidateToExtracted(existing), candidate));
    const evidenceSubquestionCandidates = splitSubquestionEvidenceCandidate(mergedCandidate);
    const splitCandidates =
      evidenceSubquestionCandidates.length > 0 ? evidenceSubquestionCandidates : splitTextSubquestionCandidate(mergedCandidate);
    if (splitCandidates.length > 0) {
      await tx.questionCandidate.update({
        where: { id: candidateId },
        data: {
          reviewStatus: CandidateStatus.UNPROCESSABLE,
          validationErrors: toInputJson([]),
          extractedPayload: toInputJson(mergedCandidate)
        }
      });
      for (const subquestionCandidate of splitCandidates) {
        await upsertSolvedSubquestionCandidate(tx, existing.sourcePaperId, subquestionCandidate);
      }
      return true;
    }

    const taxonomy = await resolveCandidateTaxonomy(tx, mergedCandidate);
    const fieldConfidences = fieldConfidenceRows(mergedCandidate);
    await tx.questionCandidate.update({
      where: { id: candidateId },
      data: candidatePersistenceData(mergedCandidate, taxonomy)
    });
    await replaceFieldConfidences(tx, candidateId, fieldConfidences);
    return false;
  });
}

async function upsertSolvedSubquestionCandidate(
  tx: Prisma.TransactionClient,
  sourcePaperId: string,
  candidate: ExtractedQuestionCandidate
) {
  const taxonomy = await resolveCandidateTaxonomy(tx, candidate);
  const fingerprint = candidateFingerprint(candidate);
  const fieldConfidences = fieldConfidenceRows(candidate);
  const candidateData = candidatePersistenceData(candidate, taxonomy);
  const existingCandidate = await tx.questionCandidate.findUnique({
    where: {
      sourcePaperId_fingerprint: {
        sourcePaperId,
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
    return;
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
    return;
  }

  await tx.questionCandidate.create({
    data:
      fieldConfidences.length > 0
        ? {
            sourcePaperId,
            fingerprint,
            ...candidateData,
            fieldConfidences: {
              create: fieldConfidences
            }
          }
        : {
            sourcePaperId,
            fingerprint,
            ...candidateData
          },
    select: { id: true }
  });
}

export function splitSubquestionEvidenceCandidate(candidate: ExtractedQuestionCandidate): ExtractedQuestionCandidate[] {
  const evidence = sourceEvidenceRecord(candidate.sourceEvidence);
  const rawSubquestions = subquestionEvidenceItems(evidence);
  if (!Array.isArray(rawSubquestions) || rawSubquestions.length < 2) {
    return [];
  }

  const parentQuestionNumber = candidate.questionNumber ?? candidate.parentQuestionNumber;
  if (!parentQuestionNumber) {
    return [];
  }

  const questionTextByPart = subquestionTextByPart(candidate.cleanedQuestionText);
  const stemText = candidate.stemText ?? textBeforeFirstSubquestion(candidate.cleanedQuestionText);
  const groupKey = candidate.groupKey ?? `${candidate.sectionName ?? "question"}:${parentQuestionNumber}`;
  const questionLabel = candidate.questionLabel ?? `Question ${parentQuestionNumber}`;

  return rawSubquestions.flatMap((item, index) => {
    const subquestion = sourceEvidenceRecord(item);
    const partLabel = normalizePartLabel(stringRecordValue(subquestion, "part_label") ?? stringRecordValue(subquestion, "part"));
    const answerText = stringRecordValue(subquestion, "answer_text") ?? stringRecordValue(subquestion, "answerText");
    const questionText = partLabel
      ? questionTextByPart.get(partLabel) ??
        stringRecordValue(subquestion, "cleaned_question_text") ??
        stringRecordValue(subquestion, "question_text") ??
        stringRecordValue(subquestion, "text")
      : undefined;
    if (!partLabel || !questionText || !answerText) {
      return [];
    }

    const marks = numberRecordValue(subquestion, "marks") ?? distributedSubquestionMarks(candidate.marks, rawSubquestions.length);
    const solutionText = stringRecordValue(subquestion, "solution_text") ?? stringRecordValue(subquestion, "solutionText");
    const fieldConfidence = {
      ...candidate.fieldConfidence,
      marks: Math.max(candidate.fieldConfidence.marks ?? 0, marks === undefined ? 0 : 1),
      answer_text: Math.max(candidate.fieldConfidence.answer_text ?? 0, 0.95)
    };
    const splitCandidate: ExtractedQuestionCandidate = {
      ...candidate,
      questionNumber: `${parentQuestionNumber}(${partLabel})`,
      parentQuestionNumber,
      questionLabel,
      partLabel,
      groupKey,
      stemText,
      displayOrder: (candidate.displayOrder ?? 0) + index,
      cleanedQuestionText: questionText,
      rawOcrText: `${stemText}\n(${partLabel}) ${questionText}`,
      questionType: "SHORT_ANSWER",
      marks,
      options: undefined,
      answerText,
      solutionText,
      answerSourceType: candidate.answerSourceType,
      answerSourceBacked: candidate.answerSourceBacked,
      fieldConfidence,
      validationErrors: reconcileMergedValidationErrors({
        ...candidate,
        questionType: "SHORT_ANSWER",
        marks,
        options: undefined,
        answerText,
        answerSourceBacked: candidate.answerSourceBacked,
        fieldConfidence,
        validationErrors: candidate.validationErrors
      }),
      sourceEvidence: subquestion
    };

    return [splitCandidate];
  });
}

export function splitTextSubquestionCandidate(candidate: ExtractedQuestionCandidate): ExtractedQuestionCandidate[] {
  if (mapQuestionType(candidate.questionType) === QuestionType.MCQ) {
    return [];
  }

  const romanGroupCandidates = splitRomanGroupCandidate(candidate);
  if (romanGroupCandidates.length > 0) {
    return romanGroupCandidates;
  }

  const evidence = sourceEvidenceRecord(candidate.sourceEvidence);
  const sourceEvidenceText = stringRecordValue(evidence, "source_evidence_text");
  const questionTextByPart =
    firstSubquestionTextByPart(candidate.cleanedQuestionText, candidate.rawOcrText, sourceEvidenceText);
  if (questionTextByPart.size < 2) {
    return [];
  }

  const parentQuestionNumber = candidate.partLabel
    ? candidate.parentQuestionNumber ?? candidate.questionNumber
    : candidate.questionNumber ?? candidate.parentQuestionNumber;
  if (!parentQuestionNumber) {
    return [];
  }

  const partCount = questionTextByPart.size;
  const stemText = candidate.stemText ?? textBeforeFirstSubquestion(candidate.cleanedQuestionText);
  const groupKey = candidate.groupKey ?? `${candidate.sectionName ?? "question"}:${parentQuestionNumber}`;
  const questionLabel = candidate.questionLabel ?? `Question ${parentQuestionNumber}`;
  const evidenceMarks = numberRecordValue(sourceEvidenceRecord(candidate.sourceEvidence), "marks");
  const marksByPart = allocatedMarksForParts(candidate, partCount);
  const distributedMarks = distributedSubquestionMarks(evidenceMarks ?? candidate.marks, partCount);
  const marks = marksByPart?.[0] ?? distributedMarks;
  const fieldConfidence = {
    ...candidate.fieldConfidence,
    marks: Math.max(candidate.fieldConfidence.marks ?? 0, marks === undefined ? 0 : 0.9)
  };

  return Array.from(questionTextByPart.entries()).map(([partLabel, questionText], index) => ({
    ...candidate,
    questionNumber: `${parentQuestionNumber}(${partLabel})`,
    parentQuestionNumber,
    questionLabel,
    partLabel,
    groupKey,
    stemText,
    displayOrder: (candidate.displayOrder ?? 0) + index,
    cleanedQuestionText: questionText,
    rawOcrText: `${stemText}\n(${partLabel}) ${questionText}`,
    marks: marksByPart?.[index] ?? distributedMarks,
    fieldConfidence,
    validationErrors: reconcileMergedValidationErrors({
      ...candidate,
      marks: marksByPart?.[index] ?? distributedMarks,
      fieldConfidence,
      validationErrors: candidate.answerText ? candidate.validationErrors : [...candidate.validationErrors, "ANSWER_UNCERTAIN"]
    }),
    sourceEvidence: {
      ...sourceEvidenceRecord(candidate.sourceEvidence),
      parent_marks: candidate.marks,
      part_label: partLabel
    }
  }));
}

export function splitNumberedListCandidate(candidate: ExtractedQuestionCandidate): ExtractedQuestionCandidate[] {
  if (
    candidate.parentQuestionNumber ||
    candidate.partLabel ||
    mapQuestionType(candidate.questionType) === QuestionType.MCQ
  ) {
    return [];
  }

  const questionTextByNumber = numberedQuestionTextByPart(candidate.cleanedQuestionText);
  if (questionTextByNumber.size < 2) {
    return [];
  }

  const firstNumber = questionTextByNumber.keys().next().value;
  if (candidate.questionNumber && firstNumber && candidate.questionNumber !== firstNumber) {
    return [];
  }

  const partCount = questionTextByNumber.size;
  const evidence = sourceEvidenceRecord(candidate.sourceEvidence);
  const evidenceMarks = numberRecordValue(evidence, "marks");
  const marksByPart = allocatedMarksForParts(candidate, partCount);
  if (
    !marksByPart &&
    candidate.questionNumber &&
    (candidate.marks ?? 0) <= 1 &&
    !looksLikeSectionTotalMarks({
      evidenceMarks,
      evidenceQuestionNumber: candidate.questionNumber,
      sectionName: candidate.sectionName
    })
  ) {
    return [];
  }
  const distributedMarks = distributedSubquestionMarks(evidenceMarks ?? candidate.marks, partCount);
  const marks = marksByPart?.[0] ?? distributedMarks;
  const fieldConfidence = {
    ...candidate.fieldConfidence,
    marks: Math.max(candidate.fieldConfidence.marks ?? 0, marks === undefined ? 0 : 0.9)
  };

  return Array.from(questionTextByNumber.entries()).map(([questionNumber, questionText], index) => {
    const candidateMarks = marksByPart?.[index] ?? distributedMarks;
    return {
      ...candidate,
      questionNumber,
      parentQuestionNumber: undefined,
      questionLabel: `Question ${questionNumber}`,
      partLabel: undefined,
      groupKey: undefined,
      stemText: undefined,
      displayOrder: (candidate.displayOrder ?? 0) + index,
      cleanedQuestionText: questionText,
      rawOcrText: `${questionNumber}. ${questionText}`,
      marks: candidateMarks,
      fieldConfidence,
      validationErrors: reconcileMergedValidationErrors({
        ...candidate,
        marks: candidateMarks,
        fieldConfidence,
        validationErrors: candidate.answerText ? candidate.validationErrors : [...candidate.validationErrors, "ANSWER_UNCERTAIN"]
      }),
      sourceEvidence: {
        ...sourceEvidenceRecord(candidate.sourceEvidence),
        parent_marks: candidate.marks,
        question_number: questionNumber
      }
    };
  });
}

function splitRomanGroupCandidate(candidate: ExtractedQuestionCandidate): ExtractedQuestionCandidate[] {
  const parentQuestionNumber = candidate.questionNumber ?? candidate.parentQuestionNumber ?? candidate.sectionName;
  if (!parentQuestionNumber) {
    return [];
  }

  const romanGroups = romanGroupTextByPart(candidate.cleanedQuestionText);
  if (romanGroups.size < 2) {
    return [];
  }

  return Array.from(romanGroups.entries()).map(([romanLabel, group], index) => {
    const questionNumber = `${parentQuestionNumber}.${romanLabel}`;
    const marks = group.marks ?? distributedSubquestionMarks(candidate.marks, romanGroups.size);
    const fieldConfidence = {
      ...candidate.fieldConfidence,
      marks: Math.max(candidate.fieldConfidence.marks ?? 0, marks === undefined ? 0 : 0.9)
    };

    return {
      ...candidate,
      questionNumber,
      parentQuestionNumber,
      questionLabel: romanLabel,
      partLabel: undefined,
      groupKey: questionNumber,
      stemText: textBeforeFirstSubquestion(group.text),
      displayOrder: (candidate.displayOrder ?? 0) + index,
      cleanedQuestionText: group.text,
      rawOcrText: group.text,
      marks,
      fieldConfidence,
      validationErrors: reconcileMergedValidationErrors({
        ...candidate,
        marks,
        fieldConfidence,
        validationErrors: candidate.answerText ? candidate.validationErrors : [...candidate.validationErrors, "ANSWER_UNCERTAIN"]
      }),
      sourceEvidence: {
        ...sourceEvidenceRecord(candidate.sourceEvidence),
        parent_marks: candidate.marks,
        roman_label: romanLabel
      }
    };
  });
}

function subquestionEvidenceItems(evidence: Record<string, unknown>) {
  const rawItems = evidence.subquestions ?? evidence.sub_questions ?? evidence.subparts ?? evidence.parts;
  return Array.isArray(rawItems) ? rawItems : undefined;
}

function hydrateCandidateFromEvidence(candidate: ExtractedQuestionCandidate): ExtractedQuestionCandidate {
  const evidence = sourceEvidenceRecord(candidate.sourceEvidence);
  const evidenceTextIdentity = questionIdentityFromEvidenceText(stringRecordValue(evidence, "source_evidence_text"));
  const sectionName = nonEmptySolvedValue(candidate.sectionName, stringRecordValue(evidence, "section_name"));
  const evidenceQuestionNumber = stringRecordValue(evidence, "question_number") ?? evidenceTextIdentity.questionNumber;
  const questionNumber = nonEmptySolvedValue(candidate.questionNumber, evidenceQuestionNumber);
  const marks = candidate.marks ?? normalizedEvidenceMarks(candidate, {
    evidenceMarks:
      numberRecordValue(evidence, "marks") ?? evidenceTextIdentity.marks ?? defaultMarksForCandidate(candidate, questionNumber),
    evidenceQuestionNumber,
    sectionName
  });
  const parentQuestionNumber = nonEmptySolvedValue(
    candidate.parentQuestionNumber,
    stringRecordValue(evidence, "parent_question_number")
  );
  const partLabel = nonEmptySolvedValue(candidate.partLabel, stringRecordValue(evidence, "part_label"));
  const normalizedQuestionNumber = normalizedGroupedQuestionNumber({
    questionNumber,
    parentQuestionNumber,
    partLabel
  });
  const groupKey = nonEmptySolvedValue(candidate.groupKey, stringRecordValue(evidence, "group_key"));
  const displayOrder = candidate.displayOrder ?? numberRecordValue(evidence, "display_order");
  const pageNumber = candidate.pageNumber ?? numberRecordValue(evidence, "page_number");
  const fieldConfidence = {
    ...candidate.fieldConfidence,
    marks: Math.max(candidate.fieldConfidence.marks ?? 0, marks === undefined ? 0 : 0.9)
  };
  const hydrated = {
    ...candidate,
    questionNumber: normalizedQuestionNumber,
    parentQuestionNumber,
    questionLabel: normalizedQuestionLabel({
      solvedQuestionLabel: candidate.questionLabel,
      existingQuestionLabel: undefined,
      parentQuestionNumber,
      partLabel
    }),
    partLabel,
    groupKey,
    sectionName,
    pageNumber,
    displayOrder,
    marks,
    fieldConfidence
  };

  return {
    ...hydrated,
    validationErrors: reconcileMergedValidationErrors(hydrated)
  };
}

function normalizedGroupedQuestionNumber(input: {
  questionNumber: string | undefined;
  parentQuestionNumber: string | undefined;
  partLabel: string | undefined;
}) {
  const partLabel = normalizePartLabel(input.partLabel);
  if (input.parentQuestionNumber && partLabel) {
    return `${input.parentQuestionNumber}(${partLabel})`;
  }

  const compactPartMatch = /^(\d+)([a-h])$/iu.exec(input.questionNumber ?? "");
  if (compactPartMatch?.[1] && compactPartMatch[2]) {
    return `${compactPartMatch[1]}(${compactPartMatch[2].toLowerCase()})`;
  }

  return input.questionNumber;
}

function isNestedDetailCandidate(candidate: ExtractedQuestionCandidate) {
  const partLabel = candidate.partLabel ?? stringRecordValue(sourceEvidenceRecord(candidate.sourceEvidence), "part_label");
  return Boolean(candidate.parentQuestionNumber && /^[a-h]\.(?:i{1,3}|iv|v)$/iu.test(partLabel ?? ""));
}

export function questionIdentityFromEvidenceText(text: string | undefined) {
  if (!text) {
    return {};
  }

  const normalizedText = text.replace(/^\s*#+\s*/u, "").trim();
  const romanSectionMatch = /^\s*([IVX]+)\.?\s+(?:(i{1,3}|iv|v|vi{0,3}|ix|x)[.)]?)?/iu.exec(normalizedText);
  const romanSectionWithLineBreakMatch = /^\s*([IVX]+)\s*\n+\s*(i{1,3}|iv|v|vi{0,3}|ix|x)[.)]/iu.exec(normalizedText);
  const romanOnlyMatch = /^\s*(i{1,3}|iv|v|vi{0,3}|ix|x)[.)]/iu.exec(normalizedText);
  const numericMatch = /^\s*(\d{1,2})[.)]\s+/u.exec(normalizedText);
  const romanSection = romanSectionWithLineBreakMatch?.[1] ?? romanSectionMatch?.[1];
  const romanPart = romanSectionWithLineBreakMatch?.[2] ?? romanSectionMatch?.[2];
  const questionNumber =
    romanSection && romanPart
      ? `${romanSection.toUpperCase()}.${romanPart.toLowerCase()}`
      : romanSection
        ? romanSection.toUpperCase()
        : romanOnlyMatch?.[1]?.toLowerCase() ?? numericMatch?.[1];

  return {
    questionNumber,
    marks: inlineMarksFromEvidenceText(normalizedText)
  };
}

function inlineMarksFromEvidenceText(text: string) {
  const allocation = markAllocationFromText(text);
  if (allocation) {
    return allocation.reduce((total, mark) => total + mark, 0);
  }

  const marks = Array.from(text.matchAll(/\((\d+(?:\.\d+)?)\s*(?:marks?)?\)/giu))
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value));
  return marks.length > 0 ? marks[0] : undefined;
}

function defaultMarksForCandidate(candidate: ExtractedQuestionCandidate, questionNumber: string | undefined) {
  if (questionNumber && mapQuestionType(candidate.questionType) === QuestionType.MCQ) {
    return 1;
  }
  if (candidate.partLabel && /case\s*study/iu.test(candidate.sectionName ?? "")) {
    return 1;
  }
  return undefined;
}

function firstSubquestionTextByPart(...texts: Array<string | undefined>) {
  for (const text of texts) {
    if (!text) {
      continue;
    }
    const questionTextByPart = subquestionTextByPart(text);
    if (questionTextByPart.size >= 2) {
      return questionTextByPart;
    }
  }

  return new Map<string, string>();
}

function romanGroupTextByPart(text: string) {
  const entries = new Map<string, { text: string; marks: number | undefined }>();
  const normalizedText = text.replace(/(^|\n)\s*#\s*/gu, "$1");
  const romanPattern =
    /(?:^|\n)\s*(i{1,3}|iv|v|vi{0,3}|ix|x)\)\s*(?:\((\d+(?:\.\d+)?)\))?\s*([\s\S]*?)(?=\n\s*(?:i{1,3}|iv|v|vi{0,3}|ix|x)\)\s*(?:\(\d+(?:\.\d+)?\))?\s*|$)/giu;

  for (const match of normalizedText.matchAll(romanPattern)) {
    const romanLabel = match[1]?.toLowerCase();
    const explicitMarks = match[2] ? Number(match[2]) : undefined;
    const groupText = match[3]?.trim();
    if (!romanLabel || !groupText) {
      continue;
    }

    entries.set(romanLabel, {
      text: groupText,
      marks: explicitMarks ?? marksFromStandaloneAllocation(groupText)
    });
  }

  return entries;
}

function marksFromStandaloneAllocation(text: string) {
  const match = /(?:^|\n)\s*\(?(\d+(?:\.\d+)?)\)?\s*(?:\n|$)/u.exec(text);
  if (!match?.[1]) {
    return undefined;
  }

  const marks = Number(match[1]);
  return Number.isFinite(marks) ? marks : undefined;
}

function mergeSolvedCandidate(
  existing: ExtractedQuestionCandidate,
  solved: ExtractedQuestionCandidate
): ExtractedQuestionCandidate {
  const evidence = sourceEvidenceRecord(solved.sourceEvidence);
  const marks = existing.marks ?? solved.marks ?? numberRecordValue(evidence, "marks");
  const evidenceAnswerText = stringRecordValue(evidence, "answer_text") ?? stringRecordValue(evidence, "answerText");
  const parentQuestionNumber = nonEmptySolvedValue(
    solved.parentQuestionNumber,
    stringRecordValue(evidence, "parent_question_number") ?? existing.parentQuestionNumber
  );
  const partLabel = nonEmptySolvedValue(solved.partLabel, stringRecordValue(evidence, "part_label") ?? existing.partLabel);
  const answerText = nonEmptySolvedValue(
    solved.answerText,
    evidenceAnswerText ?? existing.answerText
  );
  const solvedProvidedAnswer =
    (solved.answerText?.trim() !== undefined && solved.answerText.trim().length > 0) || evidenceAnswerText !== undefined;
  const merged = {
    ...existing,
    questionNumber: nonEmptySolvedValue(solved.questionNumber, stringRecordValue(evidence, "question_number") ?? existing.questionNumber),
    sectionName: nonEmptySolvedValue(solved.sectionName, stringRecordValue(evidence, "section_name") ?? existing.sectionName),
    pageNumber: solved.pageNumber ?? existing.pageNumber,
    sourcePageStart: solved.sourcePageStart ?? existing.sourcePageStart,
    sourcePageEnd: solved.sourcePageEnd ?? existing.sourcePageEnd,
    rawOcrText: nonEmptySolvedValue(solved.rawOcrText, existing.rawOcrText),
    cleanedQuestionText: nonEmptySolvedValue(solved.cleanedQuestionText, existing.cleanedQuestionText),
    parentQuestionNumber,
    questionLabel: normalizedQuestionLabel({
      solvedQuestionLabel: solved.questionLabel,
      existingQuestionLabel: existing.questionLabel,
      parentQuestionNumber,
      partLabel
    }),
    partLabel,
    groupKey: nonEmptySolvedValue(solved.groupKey, stringRecordValue(evidence, "group_key") ?? existing.groupKey),
    stemText: nonEmptySolvedValue(solved.stemText, existing.stemText),
    displayOrder: solved.displayOrder ?? existing.displayOrder,
    questionType: solved.questionType === "UNKNOWN" ? existing.questionType : solved.questionType,
    marks,
    options: solved.options ?? existing.options,
    answerText,
    solutionText: nonEmptySolvedValue(solved.solutionText, existing.solutionText),
    answerSourceType: solvedProvidedAnswer ? solved.answerSourceType : existing.answerSourceType,
    answerSourceBacked: solvedProvidedAnswer ? solved.answerSourceBacked : existing.answerSourceBacked,
    chapter: nonEmptySolvedValue(solved.chapter, existing.chapter),
    topic: nonEmptySolvedValue(solved.topic, existing.topic),
    subtopic: nonEmptySolvedValue(solved.subtopic, existing.subtopic),
    difficulty: nonEmptySolvedValue(solved.difficulty, existing.difficulty),
    bloomLevel: nonEmptySolvedValue(solved.bloomLevel, existing.bloomLevel),
    requiresDiagram: solved.requiresDiagram || existing.requiresDiagram,
    diagramAsset: solved.diagramAsset ?? existing.diagramAsset,
    fieldConfidence: {
      ...existing.fieldConfidence,
      ...solved.fieldConfidence
    },
    overallConfidence: Math.max(existing.overallConfidence, solved.overallConfidence),
    validationErrors: reconcileMergedValidationErrors({
      ...existing,
      ...solved,
      marks,
      options: solved.options ?? existing.options,
      answerText,
      cleanedQuestionText: nonEmptySolvedValue(solved.cleanedQuestionText, existing.cleanedQuestionText),
      validationErrors: [...existing.validationErrors, ...solved.validationErrors]
    }),
    sourceEvidence: solved.sourceEvidence ?? existing.sourceEvidence
  };

  return merged;
}

function nonEmptySolvedValue<T extends string | undefined>(solvedValue: T, existingValue: T) {
  return solvedValue?.trim() ? solvedValue : existingValue;
}

function normalizedQuestionLabel(input: {
  solvedQuestionLabel: string | undefined;
  existingQuestionLabel: string | undefined;
  parentQuestionNumber: string | undefined;
  partLabel: string | undefined;
}) {
  const solvedLabel = input.solvedQuestionLabel?.trim();
  const partLabel = normalizePartLabel(input.partLabel);
  if (solvedLabel && (!partLabel || normalizePartLabel(solvedLabel) !== partLabel)) {
    return solvedLabel;
  }
  if (input.existingQuestionLabel?.trim() && (!partLabel || normalizePartLabel(input.existingQuestionLabel) !== partLabel)) {
    return input.existingQuestionLabel;
  }
  return input.parentQuestionNumber ? `Question ${input.parentQuestionNumber}` : input.existingQuestionLabel;
}

function sourceEvidenceRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringRecordValue(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function numberRecordValue(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function subquestionTextByPart(text: string) {
  const entries = new Map<string, string>();
  const normalizedText = text.replace(/([^\n])\s+((?:[-*•]\s*)?\(?[a-h]\)?[.)]\s+)/giu, "$1\n$2");
  const labelPrefixPattern = "\\s*(?:[-*•]\\s*)?";
  const partPattern = new RegExp(
    `(?:^|\\n)${labelPrefixPattern}\\(?([a-h])\\)?[.)]\\s*([\\s\\S]*?)(?=\\n${labelPrefixPattern}\\(?[a-h]\\)?[.)]\\s*|$)`,
    "giu"
  );
  for (const match of normalizedText.matchAll(partPattern)) {
    const partLabel = normalizePartLabel(match[1]);
    const questionText = match[2]?.replace(/\(\s*\d+(?:\.\d+)?\s*marks?\s*\)\s*$/iu, "").trim();
    if (partLabel && questionText) {
      entries.set(partLabel, questionText);
    }
  }
  return entries;
}

function numberedQuestionTextByPart(text: string) {
  const entries = new Map<string, string>();
  const normalizedText = text.replace(/([^\n])\s+(\d{1,2}[.)]\s+)/gu, "$1\n$2");
  const numberPattern = /(?:^|\n)\s*(\d{1,2})[.)]\s*([\s\S]*?)(?=\n\s*\d{1,2}[.)]\s*|$)/gu;
  for (const match of normalizedText.matchAll(numberPattern)) {
    const questionNumber = match[1];
    const questionText = match[2]?.replace(/\(\s*\d+(?:\.\d+)?\s*marks?\s*\)\s*$/iu, "").trim();
    if (questionNumber && questionText) {
      entries.set(questionNumber, questionText);
    }
  }
  return entries;
}

function textBeforeFirstSubquestion(text: string) {
  return (
    text
      .replace(/([^\n])\s+((?:[-*•]\s*)?\(?[a-h]\)?[.)]\s+)/giu, "$1\n$2")
      .split(/\n\s*(?:[-*•]\s*)?\(?[a-h]\)?[.)]\s*/iu)[0]
      ?.replace(/Answer the following questions?:?\s*$/iu, "")
      .trim() ?? text
  );
}

function normalizePartLabel(value: string | undefined) {
  const match = /^\(?\s*([a-z])\s*\)?$/iu.exec(value ?? "");
  return match?.[1]?.toLowerCase();
}

function distributedSubquestionMarks(totalMarks: number | undefined, partCount: number) {
  if (totalMarks === undefined || partCount <= 0) {
    return undefined;
  }

  const distributedMarks = totalMarks / partCount;
  return Number.isFinite(distributedMarks) ? distributedMarks : undefined;
}

function allocatedMarksForParts(candidate: ExtractedQuestionCandidate, partCount: number) {
  const evidence = sourceEvidenceRecord(candidate.sourceEvidence);
  const textCandidates = [
    candidate.rawOcrText,
    candidate.cleanedQuestionText,
    stringRecordValue(evidence, "source_evidence_text")
  ];
  for (const text of textCandidates) {
    const marks = text ? markAllocationFromText(text) : undefined;
    if (marks?.length === partCount) {
      return marks;
    }
  }
  return undefined;
}

function markAllocationFromText(text: string) {
  const match = /\((\s*\d+(?:\.\d+)?(?:\s*\+\s*\d+(?:\.\d+)?)+)(?:\s*=\s*\d+(?:\.\d+)?\s*marks?)?\s*\)/iu.exec(text);
  if (!match?.[1]) {
    return undefined;
  }

  const marks = match[1].split("+").map((value) => Number(value.trim()));
  return marks.every((mark) => Number.isFinite(mark)) ? marks : undefined;
}

function normalizedEvidenceMarks(
  candidate: ExtractedQuestionCandidate,
  input: {
    evidenceMarks: number | undefined;
    evidenceQuestionNumber: string | undefined;
    sectionName: string | undefined;
  }
) {
  if (input.evidenceMarks === undefined) {
    return undefined;
  }

  return looksLikeSectionTotalMarks({
    evidenceMarks: input.evidenceMarks,
    evidenceQuestionNumber: candidate.questionNumber ?? input.evidenceQuestionNumber,
    sectionName: input.sectionName
  })
    ? 1
    : input.evidenceMarks;
}

function looksLikeSectionTotalMarks(input: {
  evidenceMarks: number | undefined;
  evidenceQuestionNumber: string | undefined;
  sectionName: string | undefined;
}) {
  const sectionName = input.sectionName?.toLowerCase() ?? "";
  return Boolean(
    input.evidenceMarks !== undefined &&
      input.evidenceMarks >= 3 &&
      input.evidenceQuestionNumber &&
      /\b(mcq|fill|true|false|name the kind|state whether)\b/u.test(sectionName)
  );
}

function reconcileMergedValidationErrors(candidate: ExtractedQuestionCandidate) {
  return [...new Set(candidate.validationErrors)].filter((reason) => {
    const answerConfidence = candidate.fieldConfidence.answer_text ?? 0;
    const hasConfidentAnswer = Boolean(candidate.answerText?.trim()) && answerConfidence >= 0.9;
    if (reason === "MISSING_QUESTION_TEXT") {
      return candidate.cleanedQuestionText.trim().length === 0;
    }
    if (reason === "MISSING_MARKS") {
      return candidate.marks === undefined;
    }
    if (reason === "MCQ_OPTIONS_MISSING") {
      return candidate.questionType === "MCQ" && !mergedCandidateHasMcqOptions(candidate.options);
    }
    if (reason === "ANSWER_UNCERTAIN") {
      return !hasConfidentAnswer;
    }
    if (reason === "LLM_GENERATED_ANSWER_UNVERIFIED") {
      return !hasConfidentAnswer;
    }
    return true;
  });
}

function mergedCandidateHasMcqOptions(value: unknown) {
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === "string" && item.trim().length > 0).length >= 2;
  }
  return false;
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
        solveError: serializeSolveError(error)
      })
    }
  });
}

async function solveCandidateWithRetry(input: {
  extractor: ReturnType<typeof createQuestionExtractorFromEnv>;
  candidate: ExtractedQuestionCandidate;
  imageUrls: Array<{ url: string; label: string }>;
}) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await input.extractor.solveCandidate(input.candidate, input.imageUrls);
    } catch (error) {
      lastError = error;
      if (attempt < 5) {
        await sleep(solveRetryDelayMs(error, attempt));
      }
    }
  }

  throw lastError;
}

function solveRetryDelayMs(error: unknown, attempt: number) {
  const message = error instanceof Error ? error.message : String(error);
  if (/429|rate[_ -]?limit/i.test(message)) {
    return attempt * 15000;
  }

  return attempt * 1500;
}

function solverRequestIntervalFromEnv(env: NodeJS.ProcessEnv) {
  const raw = env.MISTRAL_SOLVER_REQUEST_INTERVAL_MS?.trim();
  if (!raw) {
    return 15000;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 15000;
}

function solverConcurrencyFromEnv(env: NodeJS.ProcessEnv) {
  const raw = env.MISTRAL_SOLVER_CONCURRENCY?.trim();
  if (!raw) {
    return 1;
  }

  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await worker(items[currentIndex] as T, currentIndex);
      }
    })
  );

  return results;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function serializeSolveError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      cause: serializeErrorCause(error.cause)
    };
  }

  return {
    message: String(error)
  };
}

function serializeErrorCause(cause: unknown) {
  if (cause instanceof Error) {
    return {
      name: cause.name,
      message: cause.message
    };
  }
  return cause ?? null;
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
    parentQuestionNumber: candidate.parentQuestionNumber ?? null,
    questionLabel: candidate.questionLabel ?? null,
    partLabel: candidate.partLabel ?? null,
    groupKey: candidate.groupKey ?? null,
    stemText: candidate.stemText ?? null,
    displayOrder: candidate.displayOrder ?? null,
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
    case "assertion":
    case "assertion_reason":
    case "assertion_reasoning":
      return QuestionType.MCQ;
    case "short_answer":
    case "theoretical":
      return QuestionType.SHORT_ANSWER;
    case "long_answer":
      return QuestionType.LONG_ANSWER;
    case "numerical":
      return QuestionType.NUMERICAL;
    case "true_false":
    case "true_false_correction":
    case "correct_incorrect":
    case "correct_incorrect_correction":
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
    include: {
      ocrBlocks: {
        orderBy: { createdAt: "asc" }
      }
    },
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
    blocks: page.ocrBlocks.map((block) => ({
      blockType: block.blockType,
      text: block.text,
      confidence: block.confidence ?? undefined,
      boundingBox: block.boundingBox ?? undefined,
      sourceAsset: block.sourceAsset ?? undefined,
      rawJson: block.rawJson ?? undefined
    })),
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
    parentQuestionNumber: candidate.parentQuestionNumber ?? undefined,
    questionLabel: candidate.questionLabel ?? undefined,
    partLabel: candidate.partLabel ?? undefined,
    groupKey: candidate.groupKey ?? undefined,
    stemText: candidate.stemText ?? undefined,
    displayOrder: candidate.displayOrder ?? undefined,
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
  if (!candidate.requiresDiagram) {
    return [];
  }

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
    const sourceAsset = sourceAssetRecord(block.sourceAsset);
    const objectKey = objectKeyFromSourceAsset(sourceAsset);
    if (!objectKey) {
      continue;
    }
    const image = await objectStore.readObject(objectKey);
    const mimeType = mimeTypeFromSourceAsset(sourceAsset) ?? image.contentType ?? "image/jpeg";
    imageUrls.push({
      label: `page ${block.ocrPage.pageNumber} ${block.text}`,
      url: `data:${mimeType};base64,${Buffer.from(image.body).toString("base64")}`
    });
  }

  return imageUrls;
}

function sourceAssetRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function objectKeyFromSourceAsset(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  return typeof record.objectKey === "string" ? record.objectKey : undefined;
}

function mimeTypeFromSourceAsset(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  return typeof record.mimeType === "string" ? record.mimeType : undefined;
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
