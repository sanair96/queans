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

  it("fails malformed extraction responses with a readable parser error", () => {
    expect(() =>
      parseMistralExtractionContent(
        JSON.stringify({
          candidates: [
            {
              field_confidence: {},
              overall_confidence: 0.4,
              validation_errors: [],
              source_evidence: {}
            }
          ]
        })
      )
    ).toThrow("Mistral extraction response did not match the required candidate schema.");
  });
});

describe("MistralQuestionExtractor", () => {
  it("requests strict JSON schema output for question candidates", async () => {
    const { MistralQuestionExtractor } = await import("./mistral.js");
    const fetchCalls: unknown[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (_input, init) => {
      const body = init?.body;
      if (typeof body !== "string") {
        throw new Error("Expected Mistral request body to be serialized JSON.");
      }
      fetchCalls.push(JSON.parse(body));
      const responseBody = JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({ candidates: [] })
            }
          }
        ],
        usage: {}
      });
      return Promise.resolve(
        new Response(responseBody, {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        })
      );
    };

    try {
      const extractor = new MistralQuestionExtractor({
        apiKey: "test-key",
        ocrModel: "mistral-ocr-latest",
        extractorModel: "mistral-small-latest"
      });

      await extractor.extractFromPages([
        {
          pageNumber: 1,
          markdown: "1. What is photosynthesis?",
          rawJson: {},
          blocks: []
        }
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchCalls[0]).toMatchObject({
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "question_candidates",
          strict: true,
          schema: {
            required: ["candidates"]
          }
        }
      }
    });
  });
});
