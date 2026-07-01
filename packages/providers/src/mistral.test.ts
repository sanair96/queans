import { describe, expect, it } from "vitest";

import { parseMistralExtractionContent } from "./mistral.js";

const baseCandidate = {
  raw_ocr_text: "1. What is photosynthesis?",
  cleaned_question_text: "What is photosynthesis?",
  question_type: "short_answer",
  marks: 2,
  answer_text: "The process by which plants make food using light.",
  field_confidence: {
    question_text: 0.96,
    question_type: 0.94,
    marks: 0.9,
    answer_text: 0.93
  },
  overall_confidence: 0.94,
  validation_errors: [],
  source_evidence: {
    page: 1,
    quote: "The process by which plants make food using light."
  }
};

describe("parseMistralExtractionContent", () => {
  it("preserves source-backed answer provenance", () => {
    const [candidate] = parseMistralExtractionContent(
      JSON.stringify({
        candidates: [
          {
            ...baseCandidate,
            answer_source_type: "SOURCE_KEY",
            answer_source_backed: true
          }
        ]
      })
    );

    expect(candidate?.answerSourceType).toBe("SOURCE_KEY");
    expect(candidate?.answerSourceBacked).toBe(true);
  });

  it("defaults missing answer provenance to unverified LLM generation", () => {
    const [candidate] = parseMistralExtractionContent(
      JSON.stringify({
        candidates: [baseCandidate]
      })
    );

    expect(candidate?.answerSourceType).toBe("LLM_GENERATED");
    expect(candidate?.answerSourceBacked).toBe(false);
  });

  it("preserves extracted taxonomy labels", () => {
    const [candidate] = parseMistralExtractionContent(
      JSON.stringify({
        candidates: [
          {
            ...baseCandidate,
            chapter: "Algebra",
            topic: "Linear Equations",
            subtopic: "Pair of Linear Equations"
          }
        ]
      })
    );

    expect(candidate).toMatchObject({
      chapter: "Algebra",
      topic: "Linear Equations",
      subtopic: "Pair of Linear Equations"
    });
  });
});
