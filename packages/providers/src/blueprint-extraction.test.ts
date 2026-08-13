import { describe, expect, it } from "vitest";

import {
  blueprintExtractionSystemPrompt,
  blueprintOcrPageContextPrompt,
  blueprintSkeletonExtractionUserPrompt,
  blueprintSkeletonExtractionJsonSchema,
  blueprintSkeletonExtractionResponseSchema,
  blueprintSkeletonExtractionSystemPrompt,
  consolidateBlueprintSkeletons,
  mergeQuestionSchemesWithEvidence,
  questionSchemeExtractionJsonSchema,
  questionSchemeExtractionResponseSchema,
  questionSchemeExtractionSystemPrompt,
  questionSchemeExtractionUserPrompt
} from "./blueprint-extraction-contract.js";
import { createBlueprintRuleExtractorFromEnv } from "./blueprint-extraction.js";
import { MistralBlueprintRuleExtractor } from "./mistral.js";

describe("Blueprint extraction provider selection", () => {
  it("uses the existing Mistral configuration", () => {
    const extractor = createBlueprintRuleExtractorFromEnv({ MISTRAL_API_KEY: "test-key" });

    expect(extractor).toBeInstanceOf(MistralBlueprintRuleExtractor);
  });
});

describe("marking-scheme extraction contract", () => {
  it("asks for evaluation rules, the assessment blueprint, and question-wise marking details strictly in English", () => {
    expect(blueprintExtractionSystemPrompt).not.toContain("CBSE");
    expect(blueprintExtractionSystemPrompt).toContain("English");
    expect(blueprintExtractionSystemPrompt).toContain("evaluation_rules");
    expect(blueprintExtractionSystemPrompt).toContain("assessment_blueprint");
    expect(blueprintExtractionSystemPrompt).toContain("question_marking_scheme");
  });
});

describe("two-pass Blueprint extraction contracts", () => {
  it("keeps English translation and source-page evidence mandatory in both pass prompts", () => {
    for (const prompt of [blueprintSkeletonExtractionSystemPrompt, questionSchemeExtractionSystemPrompt]) {
      expect(prompt).toContain("strictly in English");
      expect(prompt).toContain("source_pages");
    }
  });

  it("consolidates structural evidence and merges duplicate questions without losing source pages", () => {
    const skeleton = (sourcePage: number, marks: number) => ({
      document_metadata: { title: "Marking scheme", subject: null, examination: null, paper_code: null, session: null, total_marks: 10, source_pages: [sourcePage] },
      evaluation_rules: [{ rule: "Answer all questions.", source_pages: [sourcePage] }],
      assessment_blueprint: { sections: [{ name: "Section A", question_range: "1", question_type: null, choice_rules: [], declared_marks: 10, source_pages: [sourcePage] }], total_marks: 10, source_pages: [sourcePage] },
      question_index: [{ number: "1", section: "Section A", marks, part_labels: [], alternative_labels: [], source_pages: [sourcePage] }]
    });
    const consolidated = consolidateBlueprintSkeletons([skeleton(1, 5), skeleton(2, 6)]);
    expect(consolidated.skeleton.question_index[0]?.source_pages).toEqual([1, 2]);
    expect(consolidated.warnings).toContain("Conflicting skeleton question evidence for 1; retained the earliest declaration.");

    const merged = mergeQuestionSchemesWithEvidence([
      { question_marking_scheme: [{ number: "1", section: "Section A", marks: 5, parts: [], alternatives: [], value_points: ["Method"], acceptable_answers: [], marking_notes: [], source_pages: [1] }] },
      { question_marking_scheme: [{ number: "1", section: "Section B", marks: 6, parts: [], alternatives: [], value_points: ["Method", "Answer"], acceptable_answers: ["Equivalent form"], marking_notes: [], source_pages: [2] }] }
    ]);
    expect(merged.questionMarkingScheme[0]).toMatchObject({ source_pages: [1, 2], value_points: ["Method", "Answer"], acceptable_answers: ["Equivalent form"], section: "Section A", marks: 5 });
    expect(merged.warnings).toContain("Conflicting evidence for question 1 marks; retained the earliest value.");
  });

  it("validates strict skeleton and detailed question-scheme responses independently", () => {
    expect(
      blueprintSkeletonExtractionResponseSchema.parse({
        result: {
          document_metadata: { title: null, subject: "Mathematics", examination: null, paper_code: null, session: null, total_marks: 10, source_pages: [1] },
          evaluation_rules: [{ rule: "Answer all questions.", source_pages: [1] }],
          assessment_blueprint: { sections: [{ name: "Section A", question_range: "1-2", question_type: "Short answer", choice_rules: [], declared_marks: 10, source_pages: [1] }], total_marks: 10, source_pages: [1] },
          question_index: [{ number: "1", section: "Section A", marks: 5, part_labels: ["a"], alternative_labels: [], source_pages: [1] }]
        },
        confidence: 0.9,
        source_references: [{ page_number: 1 }],
        warnings: []
      }).result.question_index[0]?.number
    ).toBe("1");

    expect(
      questionSchemeExtractionResponseSchema.parse({
        result: { question_marking_scheme: [{ number: "1", section: "Section A", marks: 5, parts: [], alternatives: [], value_points: ["Correct method"], acceptable_answers: [], marking_notes: [], source_pages: [1] }] },
        confidence: 0.9,
        source_references: [{ page_number: 1 }],
        warnings: []
      }).result.question_marking_scheme[0]?.value_points
    ).toEqual(["Correct method"]);

    expect(() => questionSchemeExtractionResponseSchema.parse({ result: { question_marking_scheme: [], unexpected: true }, confidence: null, source_references: [], warnings: [] })).toThrow();
    expect(blueprintSkeletonExtractionJsonSchema.required).toEqual(["result", "confidence", "source_references", "warnings"]);
    expect(questionSchemeExtractionJsonSchema.properties.result.additionalProperties).toBe(false);
  });

  it("formats persisted OCR layout blocks and metadata-only image references for either pass", () => {
    const page = {
      pageNumber: 2,
      markdown: "## प्रश्न 1",
      averageConfidence: 0.94,
      width: 1200,
      height: 1800,
      dpi: 200,
      blocks: [{ blockType: "table", text: "1. पाँच अंक", confidence: 0.91, boundingBox: { x: 10, y: 20 }, sourceAsset: { imageId: "diagram-2" } }],
      assets: [{ sourceAssetId: "diagram-2", fileName: "diagram-2.png", mimeType: "image/png", boundingBox: { x: 30, y: 40 }, metadata: { provider: "mistral" } }]
    };
    const prompt = blueprintOcrPageContextPrompt(page);

    expect(prompt).toContain("Layout blocks:");
    expect(prompt).toContain("bounding_box={\"x\":10,\"y\":20}");
    expect(prompt).toContain("source_asset={\"imageId\":\"diagram-2\"}");
    expect(prompt).toContain("id=diagram-2; file=diagram-2.png; mime_type=image/png");
    expect(prompt).toContain("metadata only; no pixels are available");

    expect(blueprintSkeletonExtractionUserPrompt({ primaryLanguage: "hi", pages: [page] })).toContain("Designated primary language: hi");
    expect(questionSchemeExtractionUserPrompt({
      primaryLanguage: "hi",
      skeleton: {
        document_metadata: { title: null, subject: null, examination: null, paper_code: null, session: null, total_marks: null, source_pages: [2] },
        evaluation_rules: [],
        assessment_blueprint: { sections: [], total_marks: null, source_pages: [2] },
        question_index: []
      },
      pages: [page]
    })).toContain("Consolidated structural skeleton (guide only):");
  });
});
