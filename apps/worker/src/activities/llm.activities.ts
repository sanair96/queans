import type { PaperIngestionWorkflowInput } from "@queans/core";
import { prisma, Prisma } from "@queans/db";
import { loadMistralConfigFromEnv, MistralQuestionExtractor } from "@queans/providers";
import type { ExtractedQuestionCandidate } from "@queans/providers";

import { toInputJson } from "../json.js";

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

  await prisma.$transaction(async (tx) => {
    for (const candidate of extraction.candidates) {
      await tx.questionCandidate.create({
        data: {
          sourcePaperId: input.sourcePaperId,
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
          difficulty: candidate.difficulty ?? null,
          bloomLevel: candidate.bloomLevel ?? null,
          requiresDiagram: candidate.requiresDiagram,
          diagramAsset: candidate.diagramAsset === undefined ? Prisma.JsonNull : toInputJson(candidate.diagramAsset),
          extractedPayload: toInputJson(candidate),
          sourceEvidence: toInputJson(candidate.sourceEvidence),
          fieldConfidence: toInputJson(candidate.fieldConfidence),
          overallConfidence: candidate.overallConfidence,
          validationErrors: toInputJson(candidate.validationErrors),
          reviewStatus: candidate.validationErrors.length > 0 ? "NEEDS_REVIEW" : "EXTRACTED",
          fieldConfidences: {
            create: Object.entries(candidate.fieldConfidence).map(([fieldName, confidence]) => ({
              fieldName,
              confidence,
              reasonCode: reasonForCandidateField(fieldName, candidate.validationErrors) ?? null
            }))
          }
        }
      });
    }

    await tx.providerRunCost.create({
      data: {
        workflowRunId: input.ingestionRunId,
        provider: extraction.provider,
        model: extraction.model,
        operation: "question_extraction",
        inputTokenCount: extraction.usage.promptTokens ?? null,
        outputTokenCount: extraction.usage.completionTokens ?? null,
        rawUsage: toInputJson(extraction.usage)
      }
    });
  });

  return {
    candidatesExtracted: extraction.candidates.length,
    model: extraction.model
  };
}

function mapQuestionType(value: string) {
  const normalized = value.toLowerCase().replace(/[^a-z]/g, "_");
  switch (normalized) {
    case "mcq":
    case "multiple_choice":
      return "MCQ";
    case "short_answer":
      return "SHORT_ANSWER";
    case "long_answer":
      return "LONG_ANSWER";
    case "numerical":
      return "NUMERICAL";
    case "true_false":
      return "TRUE_FALSE";
    case "fill_in_the_blank":
      return "FILL_IN_THE_BLANK";
    case "matching":
      return "MATCHING";
    case "diagram":
      return "DIAGRAM";
    default:
      return "UNKNOWN";
  }
}

function reasonForCandidateField(fieldName: string, reasons: ExtractedQuestionCandidate["validationErrors"]) {
  if (fieldName.includes("answer") && reasons.includes("LOW_ANSWER_CONFIDENCE")) {
    return "LOW_ANSWER_CONFIDENCE";
  }

  if (fieldName.includes("topic") && reasons.includes("LOW_TOPIC_CONFIDENCE")) {
    return "LOW_TOPIC_CONFIDENCE";
  }

  if (reasons.includes("LOW_FIELD_CONFIDENCE")) {
    return "LOW_FIELD_CONFIDENCE";
  }

  return undefined;
}
