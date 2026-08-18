import { describe, expect, it } from "vitest";

import { createBlueprintRuleExtractorFromEnv } from "./blueprint-extraction.js";
import { blueprintOcrPageContextPrompt, blueprintSkeletonExtractionJsonSchema, blueprintSkeletonExtractionResponseSchema, blueprintSkeletonExtractionSystemPrompt, blueprintSkeletonExtractionUserPrompt, consolidateBlueprintSkeletons } from "./blueprint-extraction-contract.js";
import { MistralBlueprintRuleExtractor } from "./mistral.js";

describe("Blueprint extraction provider selection", () => {
  it("uses the existing Mistral configuration", () => {
    expect(createBlueprintRuleExtractorFromEnv({ MISTRAL_API_KEY: "test-key" })).toBeInstanceOf(MistralBlueprintRuleExtractor);
  });
});

describe("structural Blueprint extraction contract", () => {
  it("explicitly excludes question prose and detailed marking content", () => {
    expect(blueprintSkeletonExtractionSystemPrompt).toContain("structural Blueprint");
    expect(blueprintSkeletonExtractionSystemPrompt).toContain("Never return question text");
    expect(blueprintSkeletonExtractionSystemPrompt).toContain("value points");
    expect(blueprintSkeletonExtractionSystemPrompt).toContain("exactly one entry for each top-level numbered question");
    expect(blueprintSkeletonExtractionSystemPrompt).toContain("Do not create separate question_index entries for subquestions");
    expect(blueprintSkeletonExtractionSystemPrompt).not.toContain("question_marking_scheme");
    expect(blueprintSkeletonExtractionSystemPrompt).not.toContain("strictly in English");
  });

  it("validates question_index and rejects detailed question fields", () => {
    const result = {
      document_metadata: { title: null, subject: "Mathematics", examination: null, paper_code: null, session: null, total_marks: 10, source_pages: [1] },
      evaluation_rules: [{ rule: "Answer all questions.", source_pages: [1] }],
      assessment_blueprint: { sections: [{ name: "Section A", printed_identifier: null, question_range: "1-2", question_type: "Short answer", choice_rules: [], declared_marks: 10, source_pages: [1] }], total_marks: 10, source_pages: [1] },
      question_index: [{ number: "1", section: "Section A", marks: 5, question_type: "Short answer", part_labels: ["a"], alternative_labels: [], source_pages: [1] }]
    };
    expect(blueprintSkeletonExtractionResponseSchema.parse({ result, confidence: 0.9, source_references: [{ page_number: 1 }], warnings: [] }).result.question_index[0]?.number).toBe("1");
    expect(() => blueprintSkeletonExtractionResponseSchema.parse({ result: { ...result, question_index: [{ ...result.question_index[0], question_text: "copied question" }] }, confidence: null, source_references: [], warnings: [] })).toThrow();
    expect(blueprintSkeletonExtractionJsonSchema.required).toEqual(["result", "confidence", "source_references", "warnings"]);
  });

  it("consolidates overlapping chunks by question number and unions evidence", () => {
    const skeleton = (page: number, marks: number) => ({
      document_metadata: { title: "Paper", subject: null, examination: null, paper_code: null, session: null, total_marks: 10, source_pages: [page] },
      evaluation_rules: [],
      assessment_blueprint: { sections: [{ name: "Section A", printed_identifier: null, question_range: "1", question_type: null, choice_rules: [], declared_marks: 10, source_pages: [page] }], total_marks: 10, source_pages: [page] },
      question_index: [{ number: "1", section: "Section A", marks, question_type: null, part_labels: [], alternative_labels: [], source_pages: [page] }]
    });
    const consolidated = consolidateBlueprintSkeletons([skeleton(1, 5), skeleton(2, 6)]);
    expect(consolidated.skeleton.question_index[0]?.source_pages).toEqual([1, 2]);
    expect(consolidated.warnings).toContain("Conflicting question evidence for 1; retained the earliest scalar fields.");
  });

  it("consolidates equivalent section ranges and unions section evidence", () => {
    const first = sectionSkeleton({ name: " Section A ", questionRange: "1-5", sourcePage: 1, choiceRules: ["answer any 4"] });
    const second = sectionSkeleton({ name: "section   a", questionRange: "1, 2, 3, 4, 5", sourcePage: 2, choiceRules: ["answer any 5"] });

    const consolidated = consolidateBlueprintSkeletons([first, second]);

    expect(consolidated.skeleton.assessment_blueprint.sections).toHaveLength(1);
    expect(consolidated.skeleton.assessment_blueprint.sections[0]).toMatchObject({
      name: " Section A ",
      question_range: "1-5",
      choice_rules: ["answer any 4", "answer any 5"],
      source_pages: [1, 2]
    });
  });

  it("retains conflicting scalar section metadata from the earliest evidence", () => {
    const first = sectionSkeleton({ name: "Section A", questionRange: "1-5", sourcePage: 1, declaredMarks: 20, questionType: "Short answer" });
    const second = sectionSkeleton({ name: "SECTION A", questionRange: "1–5", sourcePage: 2, declaredMarks: 25, questionType: "Multiple choice" });

    const consolidated = consolidateBlueprintSkeletons([first, second]);

    expect(consolidated.skeleton.assessment_blueprint.sections).toHaveLength(1);
    expect(consolidated.skeleton.assessment_blueprint.sections[0]).toMatchObject({ declared_marks: 20, question_type: "Short answer" });
    expect(consolidated.warnings).toContain("Conflicting section evidence for SECTION A; retained the earliest declaration.");
  });

  it("keeps sections with different ranges distinct", () => {
    const consolidated = consolidateBlueprintSkeletons([
      sectionSkeleton({ name: "Section A", questionRange: "1-5", sourcePage: 1 }),
      sectionSkeleton({ name: "Section A", questionRange: "6-10", sourcePage: 2 })
    ]);

    expect(consolidated.skeleton.assessment_blueprint.sections).toHaveLength(2);
  });

  it("formats layout blocks and asset metadata without image pixels", () => {
    const page = { pageNumber: 2, markdown: "## प्रश्न 1", averageConfidence: 0.94, blocks: [{ blockType: "table", text: "1. पाँच अंक", confidence: 0.91, boundingBox: { x: 10 }, sourceAsset: { imageId: "diagram-2" } }], assets: [{ sourceAssetId: "diagram-2", fileName: "diagram-2.png", mimeType: "image/png", boundingBox: { x: 30 }, metadata: { provider: "mistral" } }] };
    const prompt = blueprintOcrPageContextPrompt(page);
    expect(prompt).toContain("Layout blocks:");
    expect(prompt).toContain("source_asset={\"imageId\":\"diagram-2\"}");
    expect(prompt).toContain("metadata only; no pixels are available");
    expect(blueprintSkeletonExtractionUserPrompt({ primaryLanguage: "hi", pages: [page] })).toContain("Structural-only extraction is required");
  });
});

function sectionSkeleton(input: { name: string; questionRange: string; sourcePage: number; choiceRules?: string[]; declaredMarks?: number; questionType?: string }) {
  return {
    document_metadata: { title: "Paper", subject: null, examination: null, paper_code: null, session: null, total_marks: 20, source_pages: [input.sourcePage] },
    evaluation_rules: [],
    assessment_blueprint: {
      sections: [{ name: input.name, printed_identifier: null, question_range: input.questionRange, question_type: input.questionType ?? null, choice_rules: input.choiceRules ?? [], declared_marks: input.declaredMarks ?? 20, source_pages: [input.sourcePage] }],
      total_marks: 20,
      source_pages: [input.sourcePage]
    },
    question_index: []
  };
}
