import { describe, expect, it } from "vitest";

import {
  createQuestionExtractorFromEnv,
  loadQuestionExtractorProviderFromEnv,
  MistralQuestionExtractor
} from "./index.js";

describe("loadQuestionExtractorProviderFromEnv", () => {
  it("defaults to Mistral when no provider is configured", () => {
    expect(loadQuestionExtractorProviderFromEnv({})).toBe("mistral");
  });

  it("normalizes the configured provider name", () => {
    expect(loadQuestionExtractorProviderFromEnv({ LLM_PROVIDER: "  MISTRAL " })).toBe("mistral");
  });

  it("rejects unsupported extractor providers instead of silently falling back", () => {
    expect(() => loadQuestionExtractorProviderFromEnv({ LLM_PROVIDER: "openai" })).toThrow(
      "Unsupported LLM_PROVIDER: openai. Supported providers: mistral"
    );
  });
});

describe("createQuestionExtractorFromEnv", () => {
  it("creates the configured Mistral extractor", () => {
    const extractor = createQuestionExtractorFromEnv({
      LLM_PROVIDER: "mistral",
      MISTRAL_API_KEY: "test-key",
      EXTRACTOR_MODEL: "mistral-small-latest"
    });

    expect(extractor).toBeInstanceOf(MistralQuestionExtractor);
  });
});
