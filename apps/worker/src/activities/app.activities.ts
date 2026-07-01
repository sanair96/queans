import {
  evaluateCandidateConfidence,
  type CandidateDecision,
  type PaperIngestionStep,
  type PaperIngestionWorkflowInput,
  type ReviewReasonCode,
  type WorkflowFailurePayload
} from "@queans/core";
import { CandidateStatus, prisma, Prisma, ReviewStatus } from "@queans/db";

import {
  duplicateMatchThreshold,
  isDuplicateConflict,
  questionTextSimilarity
} from "./duplicate-detection.js";
import { candidateOcrConfidence } from "./ocr-confidence.js";
import { toInputJson } from "../json.js";

export async function recordStepStarted(input: PaperIngestionWorkflowInput, stepName: PaperIngestionStep) {
  await prisma.$transaction([
    prisma.workflowStep.create({
      data: {
        workflowRunId: input.ingestionRunId,
        stepName,
        status: "RUNNING",
        attemptCount: 1,
        startedAt: new Date()
      }
    }),
    prisma.workflowRun.update({
      where: { id: input.ingestionRunId },
      data: {
        status: "RUNNING",
        currentStep: stepName
      }
    }),
    prisma.workflowEvent.create({
      data: {
        workflowRunId: input.ingestionRunId,
        eventType: `${stepName.toUpperCase()}_STARTED`,
        eventPayload: {}
      }
    })
  ]);
}

export async function recordStepSucceeded(
  input: PaperIngestionWorkflowInput,
  stepName: PaperIngestionStep,
  outputPayload: unknown
) {
  const latestStep = await prisma.workflowStep.findFirst({
    where: {
      workflowRunId: input.ingestionRunId,
      stepName,
      status: "RUNNING"
    },
    orderBy: { startedAt: "desc" }
  });

  if (!latestStep) {
    throw new Error(`No running workflow step found for ${stepName}`);
  }

  await prisma.$transaction([
    prisma.workflowStep.update({
      where: { id: latestStep.id },
      data: {
        status: "SUCCEEDED",
        completedAt: new Date(),
        outputPayload: toInputJson(outputPayload)
      }
    }),
    prisma.workflowEvent.create({
      data: {
        workflowRunId: input.ingestionRunId,
        eventType: `${stepName.toUpperCase()}_COMPLETED`,
        eventPayload: toInputJson(outputPayload)
      }
    })
  ]);
}

export async function detectDuplicateCandidates(input: PaperIngestionWorkflowInput) {
  const [candidates, approvedQuestions] = await Promise.all([
    prisma.questionCandidate.findMany({
      where: {
        sourcePaperId: input.sourcePaperId,
        approvedQuestionId: null,
        reviewStatus: { in: ["EXTRACTED", "NEEDS_REVIEW"] }
      },
      select: {
        id: true,
        cleanedQuestionText: true
      }
    }),
    prisma.question.findMany({
      where: { status: "APPROVED" },
      select: {
        id: true,
        questionText: true
      }
    })
  ]);

  if (candidates.length === 0) {
    return {
      candidatesChecked: candidates.length,
      duplicateMatchesCreated: 0,
      duplicateConflicts: 0
    };
  }

  const candidateIds = candidates.map((candidate) => candidate.id);

  if (approvedQuestions.length === 0) {
    await prisma.duplicateMatch.deleteMany({
      where: {
        candidateId: { in: candidateIds }
      }
    });

    return {
      candidatesChecked: candidates.length,
      duplicateMatchesCreated: 0,
      duplicateConflicts: 0
    };
  }

  let duplicateMatchesCreated = 0;
  let duplicateConflicts = 0;

  await prisma.$transaction(async (tx) => {
    await tx.duplicateMatch.deleteMany({
      where: {
        candidateId: { in: candidateIds }
      }
    });

    for (const candidate of candidates) {
      for (const question of approvedQuestions) {
        const similarity = questionTextSimilarity(candidate.cleanedQuestionText, question.questionText);
        if (similarity < duplicateMatchThreshold) {
          continue;
        }

        const conflict = isDuplicateConflict(similarity);
        await tx.duplicateMatch.create({
          data: {
            candidateId: candidate.id,
            questionId: question.id,
            similarity,
            conflict,
            details: toInputJson({
              matchedQuestionText: question.questionText
            })
          }
        });
        duplicateMatchesCreated += 1;
        if (conflict) {
          duplicateConflicts += 1;
        }
      }
    }
  });

  return {
    candidatesChecked: candidates.length,
    duplicateMatchesCreated,
    duplicateConflicts
  };
}

export async function createReviewItemsForCandidates(input: PaperIngestionWorkflowInput) {
  const [candidates, ocrPages] = await Promise.all([
    prisma.questionCandidate.findMany({
      where: {
        sourcePaperId: input.sourcePaperId,
        reviewStatus: { in: ["NEEDS_REVIEW", "EXTRACTED"] }
      },
      include: {
        duplicateMatches: {
          where: { conflict: true },
          select: {
            id: true,
            questionId: true,
            similarity: true,
            details: true
          }
        }
      }
    }),
    prisma.ocrPage.findMany({
      where: { sourcePaperId: input.sourcePaperId },
      select: {
        pageNumber: true,
        averageConfidence: true,
        minimumConfidence: true
      }
    })
  ]);

  let created = 0;
  let optionalFieldReviewsRecorded = 0;
  for (const candidate of candidates) {
    const fieldConfidence = confidenceRecord(candidate.fieldConfidence);
    const result = evaluateCandidateConfidence({
      ocr: candidateOcrConfidence(candidate, ocrPages),
      duplicateConflict: candidate.duplicateMatches.length > 0,
      fields: {
        question_text: {
          confidence: fieldConfidence.question_text ?? 0,
          present: candidate.cleanedQuestionText.length > 0,
          required: true,
          sourceBacked: true
        },
        question_type: {
          confidence: fieldConfidence.question_type ?? 0,
          present: candidate.questionType !== "UNKNOWN",
          required: true,
          sourceBacked: true
        },
        marks: {
          confidence: fieldConfidence.marks ?? 0,
          present: candidate.marks !== null,
          required: true,
          sourceBacked: true
        },
        answer_text: {
          confidence: fieldConfidence.answer_text ?? 0,
          present: candidate.answerText !== null,
          required: true,
          sourceBacked: candidate.answerSourceBacked || candidate.answerSourceType === "SOURCE_KEY"
        },
        topic_id: {
          confidence: fieldConfidence.topic_id ?? fieldConfidence.topic ?? 0,
          present: candidate.topicId !== null || fieldConfidence.topic !== undefined,
          required: false
        },
        difficulty: {
          confidence: fieldConfidence.difficulty ?? 0,
          present: candidate.difficulty !== null,
          required: false
        }
      },
      validationErrors: validationErrors(candidate.validationErrors),
      mathOrDiagramUncertain: candidate.requiresDiagram && candidate.diagramAsset === null,
      generatedAnswer: candidate.answerSourceType === "LLM_GENERATED",
      generatedAnswerValidated: candidate.answerSourceBacked
    });

    const gate = reviewGateForConfidenceDecision(result.decision);
    const candidateUpdate: Prisma.QuestionCandidateUpdateInput = {
      reviewStatus: gate.candidateStatus,
      overallConfidence: result.overallConfidence
    };
    if (gate.recordReviewReasons) {
      candidateUpdate.validationErrors = toInputJson(result.reviewReasons);
    }

    await prisma.questionCandidate.update({
      where: { id: candidate.id },
      data: candidateUpdate
    });

    if (!gate.createReviewItem) {
      if (result.decision === "APPROVE_WITH_FIELD_REVIEW") {
        optionalFieldReviewsRecorded += 1;
      }
      continue;
    }

    const existingReviewItem = await prisma.reviewItem.findFirst({
      where: {
        candidateId: candidate.id,
        status: { in: ["OPEN", "ASSIGNED", "APPROVED", "EDITED", "REJECTED", "SKIPPED"] }
      }
    });
    if (!existingReviewItem) {
      await prisma.reviewItem.create({
        data: {
          candidateId: candidate.id,
          sourcePaperId: candidate.sourcePaperId,
          reviewType: reviewTypeForReasons(result.reviewReasons),
          severity: severityForReasons(result.reviewReasons),
          reasonCodes: toInputJson(result.reviewReasons),
          status: "OPEN",
          reviewPayload: toInputJson({
            fieldReviewReasons: result.fieldReviewReasons,
            duplicateMatches: candidate.duplicateMatches,
            sourceEvidence: candidate.sourceEvidence
          })
        }
      });
      created += 1;
    }
  }

  return { reviewItemsCreated: created, optionalFieldReviewsRecorded };
}

export function reviewGateForConfidenceDecision(decision: CandidateDecision) {
  switch (decision) {
    case "AUTO_APPROVE":
      return {
        candidateStatus: CandidateStatus.APPROVED,
        createReviewItem: false,
        recordReviewReasons: false
      };
    case "APPROVE_WITH_FIELD_REVIEW":
      return {
        candidateStatus: CandidateStatus.APPROVED,
        createReviewItem: false,
        recordReviewReasons: true
      };
    case "NEEDS_REVIEW":
      return {
        candidateStatus: CandidateStatus.NEEDS_REVIEW,
        createReviewItem: true,
        recordReviewReasons: true
      };
    case "REJECT":
      return {
        candidateStatus: CandidateStatus.REJECTED,
        createReviewItem: false,
        recordReviewReasons: true
      };
  }
}

export async function hasOpenReviewItems(input: PaperIngestionWorkflowInput) {
  const count = await prisma.reviewItem.count({
    where: {
      sourcePaperId: input.sourcePaperId,
      status: { in: ["OPEN", "ASSIGNED"] }
    }
  });
  return count > 0;
}

export async function markWaitingForReview(input: PaperIngestionWorkflowInput) {
  await prisma.$transaction([
    prisma.workflowRun.update({
      where: { id: input.ingestionRunId },
      data: {
        status: "WAITING_FOR_REVIEW",
        currentStep: "wait_for_review"
      }
    }),
    prisma.sourcePaper.update({
      where: { id: input.sourcePaperId },
      data: { status: "WAITING_FOR_REVIEW" }
    }),
    prisma.workflowEvent.create({
      data: {
        workflowRunId: input.ingestionRunId,
        eventType: "REVIEW_TASK_CREATED",
        eventPayload: {}
      }
    })
  ]);
}

export async function applyReviewedItems(input: PaperIngestionWorkflowInput) {
  const reviewedItems = await prisma.reviewItem.findMany({
    where: {
      sourcePaperId: input.sourcePaperId,
      status: { in: ["APPROVED", "EDITED", "REJECTED", "SKIPPED"] },
      appliedAt: null
    }
  });

  for (const item of reviewedItems) {
    await prisma.$transaction([
      prisma.questionCandidate.update({
        where: { id: item.candidateId },
        data: candidateUpdateForReviewedItem(item.status, item.decision, item.reviewPayload)
      }),
      prisma.reviewItem.update({
        where: { id: item.id },
        data: { appliedAt: new Date() }
      })
    ]);
  }

  return { reviewedItemsApplied: reviewedItems.length };
}

export async function commitApprovedCandidates(input: PaperIngestionWorkflowInput) {
  const candidates = await prisma.questionCandidate.findMany({
    where: {
      sourcePaperId: input.sourcePaperId,
      reviewStatus: { in: ["APPROVED", "EDITED_AND_APPROVED"] },
      approvedQuestionId: null
    }
  });

  let committed = 0;
  for (const candidate of candidates) {
    await prisma.$transaction(async (tx) => {
      const question = await tx.question.create({
        data: {
          questionText: candidate.cleanedQuestionText,
          questionType: candidate.questionType,
          marks: candidate.marks,
          options: candidate.options === null ? Prisma.JsonNull : toInputJson(candidate.options),
          chapterId: candidate.chapterId,
          topicId: candidate.topicId,
          subtopicId: candidate.subtopicId,
          difficulty: candidate.difficulty,
          bloomLevel: candidate.bloomLevel,
          status: "APPROVED",
          sourceEvidence: toInputJson(candidate.sourceEvidence ?? {})
        }
      });
      if (candidate.answerText !== null) {
        await tx.answer.create({
          data: {
            questionId: question.id,
            candidateId: candidate.id,
            answerText: candidate.answerText,
            solutionText: candidate.solutionText,
            sourceType: candidate.answerSourceType,
            reviewStatus: answerReviewStatusForCandidate(candidate)
          }
        });
      }
      await tx.questionCandidate.update({
        where: { id: candidate.id },
        data: { approvedQuestionId: question.id }
      });
    });
    committed += 1;
  }

  return { questionsCommitted: committed };
}

export async function markWorkflowCompleted(input: PaperIngestionWorkflowInput, outputPayload: unknown = {}) {
  const completionPayload = workflowCompletionPayload(input, outputPayload);
  await prisma.$transaction([
    prisma.workflowRun.update({
      where: { id: input.ingestionRunId },
      data: {
        status: "COMPLETED",
        currentStep: "complete",
        outputPayload: toInputJson(completionPayload),
        completedAt: new Date()
      }
    }),
    prisma.sourcePaper.update({
      where: { id: input.sourcePaperId },
      data: { status: "COMPLETED" }
    }),
    prisma.workflowEvent.create({
      data: {
        workflowRunId: input.ingestionRunId,
        eventType: "WORKFLOW_COMPLETED",
        eventPayload: toInputJson(completionPayload)
      }
    })
  ]);
}

export async function markWorkflowFailed(
  input: PaperIngestionWorkflowInput,
  stepName: PaperIngestionStep,
  failurePayload: WorkflowFailurePayload
) {
  const latestRunningStep = await prisma.workflowStep.findFirst({
    where: {
      workflowRunId: input.ingestionRunId,
      stepName,
      status: "RUNNING"
    },
    orderBy: { startedAt: "desc" }
  });

  await prisma.$transaction(async (tx) => {
    if (latestRunningStep) {
      await tx.workflowStep.update({
        where: { id: latestRunningStep.id },
        data: {
          status: "FAILED",
          completedAt: new Date(),
          errorPayload: toInputJson(failurePayload)
        }
      });
    }

    await tx.workflowRun.update({
      where: { id: input.ingestionRunId },
      data: {
        status: "FAILED",
        currentStep: stepName,
        errorPayload: toInputJson(failurePayload),
        completedAt: new Date()
      }
    });

    await tx.sourcePaper.update({
      where: { id: input.sourcePaperId },
      data: { status: "FAILED" }
    });

    await tx.workflowEvent.create({
      data: {
        workflowRunId: input.ingestionRunId,
        eventType: "WORKFLOW_FAILED",
        eventPayload: toInputJson({
          stepName,
          ...failurePayload
        })
      }
    });
  });
}

function confidenceRecord(value: Prisma.JsonValue) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const record: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "number") {
      record[key] = raw;
    }
  }
  return record;
}

function validationErrors(value: Prisma.JsonValue): ReviewReasonCode[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      if (item && typeof item === "object" && !Array.isArray(item) && "code" in item && typeof item.code === "string") {
        return item.code;
      }
      return undefined;
    })
    .filter((code): code is ReviewReasonCode => isReviewReason(code));
}

function isReviewReason(value: string | undefined): value is ReviewReasonCode {
  if (!value) {
    return false;
  }
  return [
    "LOW_OCR_CONFIDENCE",
    "MISSING_REQUIRED_FIELD",
    "LOW_FIELD_CONFIDENCE",
    "VALIDATION_FAILED",
    "DUPLICATE_CONFLICT",
    "ANSWER_UNCERTAIN",
    "MATH_OR_DIAGRAM_UNCERTAIN",
    "TOPIC_AMBIGUOUS",
    "CONTRADICTION_DETECTED",
    "MISSING_QUESTION_TEXT",
    "MISSING_MARKS",
    "MCQ_OPTIONS_MISSING",
    "MCQ_CORRECT_ANSWER_MISSING",
    "TOPIC_NOT_MAPPED",
    "LOW_ANSWER_CONFIDENCE",
    "DIAGRAM_ASSET_MISSING",
    "LLM_GENERATED_ANSWER_UNVERIFIED",
    "LOW_TOPIC_CONFIDENCE"
  ].includes(value);
}

function reviewTypeForReasons(reasons: ReviewReasonCode[]) {
  if (reasons.some((reason) => reason.includes("OCR") || reason.includes("DIAGRAM"))) {
    return "ocr_review";
  }
  if (reasons.some((reason) => reason.includes("ANSWER"))) {
    return "answer_review";
  }
  if (reasons.some((reason) => reason.includes("TOPIC"))) {
    return "metadata_review";
  }
  return "question_enrichment_review";
}

function severityForReasons(reasons: ReviewReasonCode[]) {
  if (reasons.some((reason) => reason === "MISSING_QUESTION_TEXT" || reason === "LOW_OCR_CONFIDENCE")) {
    return "CRITICAL";
  }
  if (reasons.some((reason) => reason.includes("ANSWER") || reason.includes("MCQ") || reason.includes("DIAGRAM"))) {
    return "HIGH";
  }
  if (reasons.some((reason) => reason.includes("TOPIC") || reason === "LOW_FIELD_CONFIDENCE")) {
    return "MEDIUM";
  }
  return "LOW";
}

export function candidateUpdateForReviewedItem(
  status: string,
  decision: string | null,
  reviewPayload: Prisma.JsonValue
): Prisma.QuestionCandidateUpdateInput {
  switch (status) {
    case "APPROVED":
      return {
        reviewStatus: "APPROVED",
        answerSourceType: "HUMAN_VERIFIED",
        answerSourceBacked: true
      };
    case "EDITED":
      return {
        ...candidatePatchFromReviewPayload(reviewPayload),
        reviewStatus: "EDITED_AND_APPROVED",
        answerSourceType: "HUMAN_VERIFIED",
        answerSourceBacked: true
      };
    case "REJECTED":
      if (decision === "MARK_UNPROCESSABLE") {
        return { reviewStatus: "UNPROCESSABLE" };
      }
      return { reviewStatus: "REJECTED" };
    case "SKIPPED":
      return { reviewStatus: "DUPLICATE" };
    default:
      return {};
  }
}

export function answerReviewStatusForCandidate(candidate: {
  answerSourceBacked: boolean;
  answerSourceType: string;
}) {
  if (
    candidate.answerSourceBacked ||
    candidate.answerSourceType === "SOURCE_KEY" ||
    candidate.answerSourceType === "HUMAN_VERIFIED"
  ) {
    return ReviewStatus.APPROVED;
  }

  return ReviewStatus.OPEN;
}

export function workflowCompletionPayload(input: PaperIngestionWorkflowInput, outputPayload: unknown) {
  return {
    sourcePaperId: input.sourcePaperId,
    ...(isRecord(outputPayload) ? outputPayload : { result: outputPayload })
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function candidatePatchFromReviewPayload(value: Prisma.JsonValue): Prisma.QuestionCandidateUpdateInput {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("candidate" in value)) {
    return {};
  }

  const candidate = value.candidate;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return {};
  }

  const patch: Prisma.QuestionCandidateUpdateInput = {};
  if ("cleanedQuestionText" in candidate && typeof candidate.cleanedQuestionText === "string") {
    const cleanedQuestionText = trimmedNonEmptyString(candidate.cleanedQuestionText);
    if (cleanedQuestionText) {
      patch.cleanedQuestionText = cleanedQuestionText;
    }
  }
  if ("answerText" in candidate && typeof candidate.answerText === "string") {
    const answerText = trimmedNonEmptyString(candidate.answerText);
    if (answerText) {
      patch.answerText = answerText;
    }
  }
  if ("solutionText" in candidate && typeof candidate.solutionText === "string") {
    patch.solutionText = nullableTrimmedString(candidate.solutionText);
  }
  if ("marks" in candidate && (typeof candidate.marks === "number" || candidate.marks === null)) {
    patch.marks = candidate.marks;
  }
  if ("answerSourceType" in candidate && candidate.answerSourceType === "SOURCE_KEY") {
    patch.answerSourceType = candidate.answerSourceType;
    patch.answerSourceBacked = true;
  }
  if ("difficulty" in candidate && typeof candidate.difficulty === "string") {
    patch.difficulty = nullableTrimmedString(candidate.difficulty);
  }
  return patch;
}

function trimmedNonEmptyString(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function nullableTrimmedString(value: string) {
  return trimmedNonEmptyString(value) ?? null;
}
