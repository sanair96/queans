import { createHash } from "node:crypto";

import type { PaperIngestionWorkflowInput } from "@queans/core";
import { CandidateStatus, prisma, Prisma, QuestionType, ReviewReason } from "@queans/db";
import { loadMistralConfigFromEnv, MistralQuestionExtractor } from "@queans/providers";
import type { ExtractedQuestionCandidate } from "@queans/providers";

import { toInputJson } from "../json.js";
import { estimateMistralExtractorCostUsd, formatCostDecimal, loadProviderPricing, upsertProviderRunCost } from "./provider-cost.js";
import { normalizeTaxonomyName } from "./taxonomy.js";

export async function extractQuestionsAndPersist(input: PaperIngestionWorkflowInput) {
  const pages = await prisma.ocrPage.findMany({
    where: { sourcePaperId: input.sourcePaperId },
    orderBy: { pageNumber: "asc" }
  });

  if (pages.length === 0) {
    throw new Error(`No OCR pages found for source paper ${input.sourcePaperId}`);
  }

  const extractor = new MistralQuestionExtractor(loadMistralConfigFromEnv(process.env));
  const extraction = await extractor.extractFromPages(
    pages.map((page) => ({
      pageNumber: page.pageNumber,
      markdown: page.markdown,
      plainText: page.plainText ?? undefined,
      averageConfidence: page.averageConfidence ?? undefined,
      minimumConfidence: page.minimumConfidence ?? undefined,
      width: page.width ?? undefined,
      height: page.height ?? undefined,
      dpi: page.dpi ?? undefined,
      rawJson: page.rawJson,
      blocks: []
    }))
  );
  const estimatedCostUsd = estimateMistralExtractorCostUsd(extraction.usage, loadProviderPricing(process.env));

  let candidatesCreated = 0;
  let candidatesUpdated = 0;
  let committedCandidatesSkipped = 0;

  await prisma.$transaction(async (tx) => {
    for (const candidate of extraction.candidates) {
      const taxonomy = await resolveCandidateTaxonomy(tx, candidate);
      const fingerprint = candidateFingerprint(candidate);
      const fieldConfidences = Object.entries(candidate.fieldConfidence).map(([fieldName, confidence]) => ({
        fieldName,
        confidence,
        reasonCode: reasonForCandidateField(fieldName, candidate.validationErrors) ?? null
      }));
      const candidateData = {
        fingerprint,
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

      const existingCandidate = await tx.questionCandidate.findUnique({
        where: {
          sourcePaperId_fingerprint: {
            sourcePaperId: input.sourcePaperId,
            fingerprint
          }
        },
        select: {
          id: true,
          approvedQuestionId: true
        }
      });

      if (existingCandidate?.approvedQuestionId) {
        committedCandidatesSkipped += 1;
        continue;
      }

      if (existingCandidate) {
        await tx.questionCandidate.update({
          where: { id: existingCandidate.id },
          data: candidateData
        });
        await tx.candidateFieldConfidence.deleteMany({ where: { candidateId: existingCandidate.id } });
        if (fieldConfidences.length > 0) {
          await tx.candidateFieldConfidence.createMany({
            data: fieldConfidences.map((fieldConfidence) => ({
              candidateId: existingCandidate.id,
              ...fieldConfidence
            }))
          });
        }
        candidatesUpdated += 1;
        continue;
      }

      const createdCandidate = await tx.questionCandidate.create({
        data:
          fieldConfidences.length > 0
            ? {
                sourcePaperId: input.sourcePaperId,
                ...candidateData,
                fieldConfidences: {
                  create: fieldConfidences
                }
              }
            : {
                sourcePaperId: input.sourcePaperId,
                ...candidateData
              },
        select: { id: true }
      });
      if (createdCandidate.id) {
        candidatesCreated += 1;
      }
    }

    await upsertProviderRunCost(tx, {
      workflowRunId: input.ingestionRunId,
      provider: extraction.provider,
      model: extraction.model,
      operation: "question_extraction",
      inputTokenCount: extraction.usage.promptTokens ?? null,
      outputTokenCount: extraction.usage.completionTokens ?? null,
      estimatedCostUsd: formatCostDecimal(estimatedCostUsd),
      rawUsage: toInputJson(extraction.usage)
    });
  });

  return {
    candidatesExtracted: extraction.candidates.length,
    candidatesCreated,
    candidatesUpdated,
    committedCandidatesSkipped,
    model: extraction.model
  };
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
