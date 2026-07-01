import { describe, expect, it } from "vitest";

import { isDuplicateConflict, normalizeQuestionText, questionTextSimilarity } from "./duplicate-detection.js";

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
});
