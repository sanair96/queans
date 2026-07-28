import { describe, expect, it } from "vitest";

import { createBlueprintRuleExtractorFromEnv } from "./blueprint-extraction.js";
import { MistralBlueprintRuleExtractor } from "./mistral.js";

describe("Blueprint extraction provider selection", () => {
  it("uses the existing Mistral configuration", () => {
    const extractor = createBlueprintRuleExtractorFromEnv({ MISTRAL_API_KEY: "test-key" });

    expect(extractor).toBeInstanceOf(MistralBlueprintRuleExtractor);
  });
});
