export interface ProviderPricing {
  mistralOcrUsdPer1000Pages: number;
  mistralExtractorInputUsdPerMillionTokens: number;
  mistralExtractorOutputUsdPerMillionTokens: number;
}

export const defaultProviderPricing: ProviderPricing = {
  mistralOcrUsdPer1000Pages: 4,
  mistralExtractorInputUsdPerMillionTokens: 0.15,
  mistralExtractorOutputUsdPerMillionTokens: 0.6
};

export function loadProviderPricing(env: NodeJS.ProcessEnv): ProviderPricing {
  return {
    mistralOcrUsdPer1000Pages: envNumber(
      env,
      "MISTRAL_OCR_USD_PER_1000_PAGES",
      defaultProviderPricing.mistralOcrUsdPer1000Pages
    ),
    mistralExtractorInputUsdPerMillionTokens: envNumber(
      env,
      "MISTRAL_EXTRACTOR_INPUT_USD_PER_MILLION_TOKENS",
      defaultProviderPricing.mistralExtractorInputUsdPerMillionTokens
    ),
    mistralExtractorOutputUsdPerMillionTokens: envNumber(
      env,
      "MISTRAL_EXTRACTOR_OUTPUT_USD_PER_MILLION_TOKENS",
      defaultProviderPricing.mistralExtractorOutputUsdPerMillionTokens
    )
  };
}

export function estimateMistralOcrCostUsd(pageCount: number, pricing: ProviderPricing) {
  return roundUsd((pageCount / 1000) * pricing.mistralOcrUsdPer1000Pages);
}

export function estimateMistralExtractorCostUsd(
  usage: {
    promptTokens?: number | undefined;
    completionTokens?: number | undefined;
  },
  pricing: ProviderPricing
) {
  const inputCost =
    ((usage.promptTokens ?? 0) / 1_000_000) * pricing.mistralExtractorInputUsdPerMillionTokens;
  const outputCost =
    ((usage.completionTokens ?? 0) / 1_000_000) * pricing.mistralExtractorOutputUsdPerMillionTokens;
  return roundUsd(inputCost + outputCost);
}

export function formatCostDecimal(value: number) {
  return value.toFixed(6);
}

function envNumber(env: NodeJS.ProcessEnv, key: string, fallback: number) {
  const rawValue = env[key]?.trim();
  if (!rawValue) {
    return fallback;
  }

  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${key} must be a non-negative number`);
  }
  return value;
}

function roundUsd(value: number) {
  return Number(value.toFixed(6));
}
