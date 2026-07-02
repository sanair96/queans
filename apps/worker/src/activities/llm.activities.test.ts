import { describe, expect, it } from "vitest";

import { CandidateStatus } from "@queans/db";
import type { ExtractedQuestionCandidate } from "@queans/providers";

import { candidateFingerprint, shouldSkipExistingCandidateForExtraction } from "./llm.activities.js";
import { normalizeTaxonomyName } from "./taxonomy.js";

describe("normalizeTaxonomyName", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeTaxonomyName("  Linear   Equations  ")).toBe("Linear Equations");
  });

  it("drops blank taxonomy names", () => {
    expect(normalizeTaxonomyName("   ")).toBeUndefined();
    expect(normalizeTaxonomyName(undefined)).toBeUndefined();
  });
});

describe("candidateFingerprint", () => {
  it("is stable across OCR whitespace and case differences", () => {
    expect(
      candidateFingerprint({
        ...baseCandidate,
        cleanedQuestionText: "  What   Is Photosynthesis?  ",
        questionNumber: " 1 "
      })
    ).toBe(
      candidateFingerprint({
        ...baseCandidate,
        cleanedQuestionText: "what is photosynthesis?",
        questionNumber: "1"
      })
    );
  });

  it("keeps the same text on different pages as separate candidates", () => {
    expect(candidateFingerprint({ ...baseCandidate, pageNumber: 1 })).not.toBe(
      candidateFingerprint({ ...baseCandidate, pageNumber: 2 })
    );
  });

  it("normalizes equivalent single-page source references", () => {
    expect(candidateFingerprint({ ...baseCandidate, pageNumber: 1 })).toBe(
      candidateFingerprint({
        ...baseCandidate,
        pageNumber: undefined,
        sourcePageStart: 1,
        sourcePageEnd: 1
      })
    );
  });
});

describe("shouldSkipExistingCandidateForExtraction", () => {
  it("preserves committed candidates during later extraction passes", () => {
    expect(
      shouldSkipExistingCandidateForExtraction({
        approvedQuestionId: "question-1",
        reviewStatus: CandidateStatus.EXTRACTED
      })
    ).toBe(true);
  });

  it.each([
    CandidateStatus.APPROVED,
    CandidateStatus.EDITED_AND_APPROVED,
    CandidateStatus.REJECTED,
    CandidateStatus.DUPLICATE,
    CandidateStatus.UNPROCESSABLE
  ])("preserves terminal candidate status %s", (reviewStatus) => {
    expect(
      shouldSkipExistingCandidateForExtraction({
        approvedQuestionId: null,
        reviewStatus
      })
    ).toBe(true);
  });

  it.each([CandidateStatus.EXTRACTED, CandidateStatus.NEEDS_REVIEW])(
    "allows mutable extraction status %s to be refreshed",
    (reviewStatus) => {
      expect(
        shouldSkipExistingCandidateForExtraction({
          approvedQuestionId: null,
          reviewStatus
        })
      ).toBe(false);
    }
  );
});

const baseCandidate = {
  pageNumber: 1,
  rawOcrText: "1. What is photosynthesis?",
  cleanedQuestionText: "What is photosynthesis?",
  questionType: "short_answer",
  marks: 2,
  answerText: "The process by which plants make food.",
  answerSourceType: "SOURCE_KEY",
  answerSourceBacked: true,
  requiresDiagram: false,
  fieldConfidence: {
    question_text: 0.95,
    question_type: 0.94,
    marks: 0.93,
    answer_text: 0.92
  },
  overallConfidence: 0.94,
  validationErrors: [],
  sourceEvidence: {
    page: 1
  }
} satisfies ExtractedQuestionCandidate;
