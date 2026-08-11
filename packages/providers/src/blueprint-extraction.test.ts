import { describe, expect, it } from "vitest";

import { blueprintExtractionSystemPrompt } from "./blueprint-extraction-contract.js";
import { createBlueprintRuleExtractorFromEnv } from "./blueprint-extraction.js";
import { MistralBlueprintRuleExtractor } from "./mistral.js";

describe("Blueprint extraction provider selection", () => {
  it("uses the existing Mistral configuration", () => {
    const extractor = createBlueprintRuleExtractorFromEnv({ MISTRAL_API_KEY: "test-key" });

    expect(extractor).toBeInstanceOf(MistralBlueprintRuleExtractor);
  });
});

describe("marking-scheme extraction contract", () => {
  it("asks for evaluation rules, the assessment blueprint, and question-wise marking details", () => {
    expect(blueprintExtractionSystemPrompt).not.toContain("CBSE");
    expect(blueprintExtractionSystemPrompt).toContain("evaluation_rules");
    expect(blueprintExtractionSystemPrompt).toContain("assessment_blueprint");
    expect(blueprintExtractionSystemPrompt).toContain("question_marking_scheme");
  });
});
