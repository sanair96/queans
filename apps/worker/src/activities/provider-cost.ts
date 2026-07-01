import { Prisma } from "@queans/db";

export interface ProviderPricing {
  mistralOcrUsdPer1000Pages: number;
  mistralExtractorInputUsdPerMillionTokens: number;
  mistralExtractorOutputUsdPerMillionTokens: number;
}

export interface ProviderRunCostInput {
  workflowRunId: string;
  provider: string;
  model: string;
  operation: string;
  pageCount?: number | null;
  inputTokenCount?: number | null;
  outputTokenCount?: number | null;
  estimatedCostUsd?: string | null;
  rawUsage?: Prisma.InputJsonValue | Prisma.NullTypes.JsonNull | null;
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

export function providerRunCostUpsertArgs(input: ProviderRunCostInput): Prisma.ProviderRunCostUpsertArgs {
  const writeData: Prisma.ProviderRunCostUncheckedUpdateInput = {
    provider: input.provider,
    model: input.model,
    pageCount: input.pageCount ?? null,
    inputTokenCount: input.inputTokenCount ?? null,
    outputTokenCount: input.outputTokenCount ?? null,
    estimatedCostUsd: input.estimatedCostUsd ?? null
  };
  if (input.rawUsage !== undefined) {
    writeData.rawUsage = input.rawUsage === null ? Prisma.JsonNull : input.rawUsage;
  }

  const createData: Prisma.ProviderRunCostUncheckedCreateInput = {
    workflowRunId: input.workflowRunId,
    operation: input.operation,
    provider: input.provider,
    model: input.model,
    pageCount: input.pageCount ?? null,
    inputTokenCount: input.inputTokenCount ?? null,
    outputTokenCount: input.outputTokenCount ?? null,
    estimatedCostUsd: input.estimatedCostUsd ?? null
  };
  if (input.rawUsage !== undefined) {
    createData.rawUsage = input.rawUsage === null ? Prisma.JsonNull : input.rawUsage;
  }

  return {
    where: {
      workflowRunId_operation: {
        workflowRunId: input.workflowRunId,
        operation: input.operation
      }
    },
    create: createData,
    update: writeData
  };
}

export async function upsertProviderRunCost(tx: Prisma.TransactionClient, input: ProviderRunCostInput) {
  return tx.providerRunCost.upsert(providerRunCostUpsertArgs(input));
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
