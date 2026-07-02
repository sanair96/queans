export const reviewReasonCodes = [
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
] as const;

export type ReviewReasonCode = (typeof reviewReasonCodes)[number];

export type CandidateDecision =
  | "AUTO_APPROVE"
  | "APPROVE_WITH_FIELD_REVIEW"
  | "NEEDS_REVIEW"
  | "REJECT";

export interface FieldConfidenceInput {
  confidence: number;
  present: boolean;
  required: boolean;
  sourceBacked?: boolean;
}

export interface CandidateConfidenceInput {
  ocr: {
    averageConfidence?: number;
    minimumConfidence?: number;
  };
  fields: Record<string, FieldConfidenceInput>;
  validationErrors: ReviewReasonCode[];
  duplicateConflict?: boolean;
  contradictionDetected?: boolean;
  mathOrDiagramUncertain?: boolean;
  generatedAnswer?: boolean;
  generatedAnswerValidated?: boolean;
}

export interface ConfidencePolicy {
  requiredFieldThreshold: number;
  optionalFieldThreshold: number;
  minimumOcrConfidence: number;
  averageOcrConfidence: number;
}

export interface CandidateConfidenceResult {
  decision: CandidateDecision;
  overallConfidence: number;
  reviewRequired: boolean;
  reviewReasons: ReviewReasonCode[];
  fieldReviewReasons: Record<string, ReviewReasonCode[]>;
}

export const defaultConfidencePolicy: ConfidencePolicy = {
  requiredFieldThreshold: 0.82,
  optionalFieldThreshold: 0.72,
  minimumOcrConfidence: 0.35,
  averageOcrConfidence: 0.86
};

export function evaluateCandidateConfidence(
  input: CandidateConfidenceInput,
  policy: ConfidencePolicy = defaultConfidencePolicy
): CandidateConfidenceResult {
  const reviewReasons = new Set<ReviewReasonCode>(input.validationErrors);
  const fieldReviewReasons: Record<string, ReviewReasonCode[]> = {};

  if (input.ocr.minimumConfidence !== undefined && input.ocr.minimumConfidence < policy.minimumOcrConfidence) {
    reviewReasons.add("LOW_OCR_CONFIDENCE");
  }

  if (input.ocr.averageConfidence !== undefined && input.ocr.averageConfidence < policy.averageOcrConfidence) {
    reviewReasons.add("LOW_OCR_CONFIDENCE");
  }

  for (const [fieldName, field] of Object.entries(input.fields)) {
    const reasons: ReviewReasonCode[] = [];

    if (field.required && !field.present) {
      reasons.push("MISSING_REQUIRED_FIELD");
    }

    if (field.present && field.required && field.confidence < policy.requiredFieldThreshold) {
      reasons.push(reasonForField(fieldName));
    }

    if (field.present && !field.required && field.confidence < policy.optionalFieldThreshold) {
      reasons.push(reasonForField(fieldName));
    }

    if (field.required && field.sourceBacked === false) {
      reasons.push("VALIDATION_FAILED");
    }

    if (reasons.length > 0) {
      fieldReviewReasons[fieldName] = uniqueReasons(reasons);
      for (const reason of reasons) {
        reviewReasons.add(reason);
      }
    }
  }

  if (input.duplicateConflict) {
    reviewReasons.add("DUPLICATE_CONFLICT");
  }

  if (input.contradictionDetected) {
    reviewReasons.add("CONTRADICTION_DETECTED");
  }

  if (input.mathOrDiagramUncertain) {
    reviewReasons.add("MATH_OR_DIAGRAM_UNCERTAIN");
  }

  if (input.generatedAnswer && !input.generatedAnswerValidated) {
    reviewReasons.add("LLM_GENERATED_ANSWER_UNVERIFIED");
    reviewReasons.add("ANSWER_UNCERTAIN");
  }

  const requiredFailures = Object.values(fieldReviewReasons).some((reasons) =>
    reasons.some((reason) => reason === "MISSING_REQUIRED_FIELD" || reason === "VALIDATION_FAILED")
  );

  const hardFailures =
    requiredFailures ||
    input.validationErrors.includes("MISSING_QUESTION_TEXT") ||
    input.validationErrors.includes("MCQ_OPTIONS_MISSING") ||
    input.validationErrors.includes("MCQ_CORRECT_ANSWER_MISSING");

  const overallConfidence = computeOverallConfidence(input, policy);

  if (hardFailures) {
    return {
      decision: "NEEDS_REVIEW",
      overallConfidence,
      reviewRequired: true,
      reviewReasons: [...reviewReasons],
      fieldReviewReasons
    };
  }

  const requiredFieldNames = Object.entries(input.fields)
    .filter(([, field]) => field.required)
    .map(([fieldName]) => fieldName);
  const requiredFieldsHaveReasons = requiredFieldNames.some((fieldName) => fieldReviewReasons[fieldName]?.length);

  if (reviewReasons.size === 0) {
    return {
      decision: "AUTO_APPROVE",
      overallConfidence,
      reviewRequired: false,
      reviewReasons: [],
      fieldReviewReasons
    };
  }

  if (!requiredFieldsHaveReasons && onlyOptionalReasons(fieldReviewReasons, input.fields, [...reviewReasons])) {
    return {
      decision: "APPROVE_WITH_FIELD_REVIEW",
      overallConfidence,
      reviewRequired: true,
      reviewReasons: [...reviewReasons],
      fieldReviewReasons
    };
  }

  return {
    decision: "NEEDS_REVIEW",
    overallConfidence,
    reviewRequired: true,
    reviewReasons: [...reviewReasons],
    fieldReviewReasons
  };
}

function computeOverallConfidence(input: CandidateConfidenceInput, policy: ConfidencePolicy) {
  const fieldScores = Object.values(input.fields).map((field) => (field.present ? field.confidence : 0));
  const fieldAverage =
    fieldScores.length > 0 ? fieldScores.reduce((total, score) => total + score, 0) / fieldScores.length : 0;
  const ocrScores = [input.ocr.averageConfidence, input.ocr.minimumConfidence].filter(
    (score): score is number => score !== undefined
  );
  const ocrAverage =
    ocrScores.length > 0 ? ocrScores.reduce((total, score) => total + score, 0) / ocrScores.length : policy.averageOcrConfidence;
  return roundConfidence(fieldAverage * 0.7 + ocrAverage * 0.3);
}

function roundConfidence(confidence: number) {
  return Math.max(0, Math.min(1, Number(confidence.toFixed(4))));
}

function reasonForField(fieldName: string): ReviewReasonCode {
  if (fieldName.includes("answer")) {
    return "LOW_ANSWER_CONFIDENCE";
  }

  if (fieldName.includes("topic")) {
    return "LOW_TOPIC_CONFIDENCE";
  }

  return "LOW_FIELD_CONFIDENCE";
}

function onlyOptionalReasons(
  fieldReviewReasons: Record<string, ReviewReasonCode[]>,
  fields: Record<string, FieldConfidenceInput>,
  allReasons: ReviewReasonCode[]
) {
  const nonFieldReasons = allReasons.filter(
    (reason) => !Object.values(fieldReviewReasons).some((fieldReasons) => fieldReasons.includes(reason))
  );

  if (nonFieldReasons.length > 0) {
    return false;
  }

  return Object.entries(fieldReviewReasons).every(([fieldName]) => fields[fieldName]?.required === false);
}

function uniqueReasons(reasons: ReviewReasonCode[]) {
  return [...new Set(reasons)];
}
