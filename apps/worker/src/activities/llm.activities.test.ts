import { describe, expect, it } from "vitest";

import { CandidateStatus } from "@queans/db";
import type { ExtractedQuestionCandidate } from "@queans/providers";

import { candidateFingerprint, shouldSkipExistingCandidateForExtraction, splitSubquestionEvidenceCandidate } from "./llm.activities.js";
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

describe("splitSubquestionEvidenceCandidate", () => {
  it("turns a parent case-study response into grouped answerable parts", () => {
    const parts = splitSubquestionEvidenceCandidate({
      ...baseCandidate,
      questionNumber: "1",
      parentQuestionNumber: "1",
      questionLabel: "Case Study",
      groupKey: "section-d:1",
      stemText: "A boy tries to push a heavy box on the floor.",
      cleanedQuestionText: [
        "Case Study: A boy tries to push a heavy box on the floor.",
        "Answer the following questions:",
        "(a) Which type of friction prevents the box from moving in the beginning?",
        "(b) Which type of friction comes into play once the box starts sliding?"
      ].join("\n"),
      sourceEvidence: {
        subquestions: [
          {
            part_label: "(a)",
            marks: 1,
            answer_text: "Static friction",
            solution_text: "Static friction prevents the box from moving initially."
          },
          {
            part_label: "(b)",
            marks: 1,
            answer_text: "Sliding friction",
            solution_text: "Sliding friction acts once the box starts sliding."
          }
        ]
      }
    });

    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({
      questionNumber: "1(a)",
      parentQuestionNumber: "1",
      questionLabel: "Case Study",
      partLabel: "a",
      groupKey: "section-d:1",
      stemText: "A boy tries to push a heavy box on the floor.",
      cleanedQuestionText: "Which type of friction prevents the box from moving in the beginning?",
      marks: 1,
      answerText: "Static friction",
      validationErrors: []
    });
    expect(parts[1]).toMatchObject({
      questionNumber: "1(b)",
      partLabel: "b",
      cleanedQuestionText: "Which type of friction comes into play once the box starts sliding?",
      answerText: "Sliding friction"
    });
  });
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
