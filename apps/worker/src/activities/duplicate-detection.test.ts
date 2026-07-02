import { describe, expect, it } from "vitest";

import {
  buildDuplicateMatchInputs,
  isDuplicateConflict,
  normalizeQuestionText,
  questionTextSimilarity
} from "./duplicate-detection.js";

describe("duplicate detection", () => {
  it("normalizes punctuation, case, and spacing", () => {
    expect(normalizeQuestionText("  What   is Photosynthesis? ")).toBe("what is photosynthesis");
  });

  it("treats exact normalized text as a hard duplicate", () => {
    const similarity = questionTextSimilarity("What is photosynthesis?", "what is photosynthesis");

    expect(similarity).toBe(1);
    expect(isDuplicateConflict(similarity)).toBe(true);
  });

  it("keeps weakly related questions below the conflict threshold", () => {
    const similarity = questionTextSimilarity("Solve x plus 2 equals 8", "Explain the causes of rainfall");

    expect(similarity).toBeLessThan(0.88);
    expect(isDuplicateConflict(similarity)).toBe(false);
  });

  it("builds duplicate matches against approved bank questions", () => {
    expect(
      buildDuplicateMatchInputs(
        [{ id: "candidate-1", cleanedQuestionText: "What is photosynthesis?" }],
        [{ id: "question-1", questionText: "what is photosynthesis" }]
      )
    ).toEqual([
      {
        candidateId: "candidate-1",
        questionId: "question-1",
        similarity: 1,
        conflict: true,
        details: {
          matchType: "approved_question",
          matchedQuestionId: "question-1",
          matchedQuestionText: "what is photosynthesis"
        }
      }
    ]);
  });

  it("builds same-paper duplicate matches for later repeated candidates", () => {
    expect(
      buildDuplicateMatchInputs(
        [
          { id: "candidate-1", cleanedQuestionText: "Define inertia." },
          { id: "candidate-2", cleanedQuestionText: "define inertia" },
          { id: "candidate-3", cleanedQuestionText: "Explain rainfall." }
        ],
        []
      )
    ).toEqual([
      {
        candidateId: "candidate-2",
        questionId: null,
        similarity: 1,
        conflict: true,
        details: {
          matchType: "same_paper_candidate",
          matchedCandidateId: "candidate-1",
          matchedQuestionText: "Define inertia."
        }
      }
    ]);
  });
});
