import { describe, expect, it } from "vitest";

import {
  estimateMistralExtractorCostUsd,
  estimateMistralOcrCostUsd,
  formatCostDecimal,
  loadProviderPricing,
  providerRunCostUpsertArgs
} from "./provider-cost.js";

describe("provider cost estimation", () => {
  it("estimates Mistral OCR page cost", () => {
    expect(
      estimateMistralOcrCostUsd(12, {
        mistralOcrUsdPer1000Pages: 4,
        mistralExtractorInputUsdPerMillionTokens: 0.15,
        mistralExtractorOutputUsdPerMillionTokens: 0.6,
        mistralBatchDiscountRatio: 0.5
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
          mistralExtractorOutputUsdPerMillionTokens: 0.6,
          mistralBatchDiscountRatio: 0.5
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
      mistralExtractorOutputUsdPerMillionTokens: 0.3,
      mistralBatchDiscountRatio: 0.5
    });

    expect(() =>
      loadProviderPricing({
        MISTRAL_OCR_USD_PER_1000_PAGES: "-1"
      })
    ).toThrow("MISTRAL_OCR_USD_PER_1000_PAGES must be a non-negative number");
  });
});

describe("providerRunCostUpsertArgs", () => {
  it("uses workflow run and operation as the retry idempotency key", () => {
    expect(
      providerRunCostUpsertArgs({
        workflowRunId: "run-1",
        provider: "MISTRAL",
        model: "mistral-ocr-latest",
        operation: "ocr",
        pageCount: 3,
        estimatedCostUsd: "0.012000",
        rawUsage: { pagesProcessed: 3 }
      })
    ).toMatchObject({
      where: {
        workflowRunId_operation: {
          workflowRunId: "run-1",
          operation: "ocr"
        }
      },
      create: {
        workflowRunId: "run-1",
        operation: "ocr",
        provider: "MISTRAL",
        model: "mistral-ocr-latest",
        pageCount: 3,
        estimatedCostUsd: "0.012000",
        rawUsage: { pagesProcessed: 3 }
      },
      update: {
        provider: "MISTRAL",
        model: "mistral-ocr-latest",
        pageCount: 3,
        estimatedCostUsd: "0.012000",
        rawUsage: { pagesProcessed: 3 }
      }
    });
  });

  it("omits raw usage when no usage payload is available", () => {
    const args = providerRunCostUpsertArgs({
      workflowRunId: "run-1",
      provider: "mistral",
      model: "mistral-small-latest",
      operation: "question_extraction",
      inputTokenCount: 100,
      outputTokenCount: 50,
      estimatedCostUsd: "0.000045"
    });

    expect(args).toMatchObject({
      create: {
        workflowRunId: "run-1",
        operation: "question_extraction",
        provider: "mistral",
        model: "mistral-small-latest",
        inputTokenCount: 100,
        outputTokenCount: 50,
        estimatedCostUsd: "0.000045"
      },
      update: {
        provider: "mistral",
        model: "mistral-small-latest",
        inputTokenCount: 100,
        outputTokenCount: 50,
        estimatedCostUsd: "0.000045"
      }
    });
    expect(args.create).not.toHaveProperty("rawUsage");
    expect(args.update).not.toHaveProperty("rawUsage");
  });
});
