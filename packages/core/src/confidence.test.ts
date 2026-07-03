import { describe, expect, it } from "vitest";

import { evaluateCandidateConfidence } from "./confidence.js";

const cleanRequiredFields = {
  question_text: { confidence: 0.96, present: true, required: true, sourceBacked: true },
  question_type: { confidence: 0.94, present: true, required: true, sourceBacked: true },
  answer_text: { confidence: 0.93, present: true, required: true, sourceBacked: true },
  marks: { confidence: 0.88, present: true, required: true, sourceBacked: true },
  difficulty: { confidence: 0.8, present: true, required: false }
};

describe("evaluateCandidateConfidence", () => {
  it("auto-approves clean source-backed candidates", () => {
    const result = evaluateCandidateConfidence({
      ocr: { averageConfidence: 0.97, minimumConfidence: 0.91 },
      fields: cleanRequiredFields,
      validationErrors: [],
      generatedAnswer: true,
      generatedAnswerValidated: true
    });

    expect(result.decision).toBe("AUTO_APPROVE");
    expect(result.reviewRequired).toBe(false);
    expect(result.reviewReasons).toEqual([]);
  });

  it("routes required field uncertainty to review", () => {
    const result = evaluateCandidateConfidence({
      ocr: { averageConfidence: 0.96, minimumConfidence: 0.9 },
      fields: {
        ...cleanRequiredFields,
        answer_text: { confidence: 0.54, present: true, required: true, sourceBacked: true }
      },
      validationErrors: []
    });

    expect(result.decision).toBe("NEEDS_REVIEW");
    expect(result.reviewReasons).toContain("LOW_ANSWER_CONFIDENCE");
  });

  it("allows optional field review without blocking ingestion", () => {
    const result = evaluateCandidateConfidence({
      ocr: { averageConfidence: 0.96, minimumConfidence: 0.9 },
      fields: {
        ...cleanRequiredFields,
        difficulty: { confidence: 0.58, present: true, required: false }
      },
      validationErrors: []
    });

    expect(result.decision).toBe("APPROVE_WITH_FIELD_REVIEW");
    expect(result.fieldReviewReasons.difficulty).toEqual(["LOW_FIELD_CONFIDENCE"]);
  });

  it("requires review for generated answers that failed validation", () => {
    const result = evaluateCandidateConfidence({
      ocr: { averageConfidence: 0.96, minimumConfidence: 0.9 },
      fields: cleanRequiredFields,
      validationErrors: [],
      generatedAnswer: true,
      generatedAnswerValidated: false
    });

    expect(result.decision).toBe("NEEDS_REVIEW");
    expect(result.reviewReasons).toContain("ANSWER_UNCERTAIN");
    expect(result.reviewReasons).toContain("LLM_GENERATED_ANSWER_UNVERIFIED");
  });

  it("requires review for duplicate conflicts and poor OCR", () => {
    const result = evaluateCandidateConfidence({
      ocr: { averageConfidence: 0.82, minimumConfidence: 0.62 },
      fields: cleanRequiredFields,
      validationErrors: [],
      duplicateConflict: true
    });

    expect(result.decision).toBe("NEEDS_REVIEW");
    expect(result.reviewReasons).toContain("LOW_OCR_CONFIDENCE");
    expect(result.reviewReasons).toContain("DUPLICATE_CONFLICT");
  });

  it("routes missing marks to review when marks are required for committed bank questions", () => {
    const result = evaluateCandidateConfidence({
      ocr: { averageConfidence: 0.96, minimumConfidence: 0.9 },
      fields: {
        ...cleanRequiredFields,
        marks: { confidence: 0, present: false, required: true, sourceBacked: true }
      },
      validationErrors: []
    });

    expect(result.decision).toBe("NEEDS_REVIEW");
    expect(result.reviewReasons).toContain("MISSING_REQUIRED_FIELD");
    expect(result.fieldReviewReasons.marks).toEqual(["MISSING_REQUIRED_FIELD"]);
  });
});
