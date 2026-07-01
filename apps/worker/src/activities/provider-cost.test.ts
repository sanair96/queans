import { describe, expect, it } from "vitest";

import {
  estimateMistralExtractorCostUsd,
  estimateMistralOcrCostUsd,
  formatCostDecimal,
  loadProviderPricing
} from "./provider-cost.js";

describe("provider cost estimation", () => {
  it("estimates Mistral OCR page cost", () => {
    expect(
      estimateMistralOcrCostUsd(12, {
        mistralOcrUsdPer1000Pages: 4,
        mistralExtractorInputUsdPerMillionTokens: 0.15,
        mistralExtractorOutputUsdPerMillionTokens: 0.6
      })
    ).toBe(0.048);
  });

  it("estimates Mistral extractor token cost", () => {
    expect(
      estimateMistralExtractorCostUsd(
        {
          promptTokens: 1000,
          completionTokens: 500
        },
        {
          mistralOcrUsdPer1000Pages: 4,
          mistralExtractorInputUsdPerMillionTokens: 0.15,
          mistralExtractorOutputUsdPerMillionTokens: 0.6
        }
      )
    ).toBe(0.00045);
  });

  it("formats costs for the database decimal scale", () => {
    expect(formatCostDecimal(0.00045)).toBe("0.000450");
  });

  it("loads explicit env pricing and rejects invalid values", () => {
    expect(
      loadProviderPricing({
        MISTRAL_OCR_USD_PER_1000_PAGES: "2",
        MISTRAL_EXTRACTOR_INPUT_USD_PER_MILLION_TOKENS: "0.10",
        MISTRAL_EXTRACTOR_OUTPUT_USD_PER_MILLION_TOKENS: "0.30"
      })
    ).toEqual({
      mistralOcrUsdPer1000Pages: 2,
      mistralExtractorInputUsdPerMillionTokens: 0.1,
      mistralExtractorOutputUsdPerMillionTokens: 0.3
    });

    expect(() =>
      loadProviderPricing({
        MISTRAL_OCR_USD_PER_1000_PAGES: "-1"
      })
    ).toThrow("MISTRAL_OCR_USD_PER_1000_PAGES must be a non-negative number");
  });
});
