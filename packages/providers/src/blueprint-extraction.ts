import { loadMistralConfigFromEnv, MistralBlueprintRuleExtractor } from "./mistral.js";
import type { BlueprintExtractionResult, BlueprintSourceReferenceResult } from "./types.js";

export interface BlueprintRuleExtractor {
  extractRules(input: {
    primaryLanguage: string;
    pages: Array<{ pageNumber: number; markdown: string }>;
    evaluatorInstructionPageNumbers?: number[];
    markingSchemePageNumbers?: number[];
  }): Promise<BlueprintExtractionResult>;
}

export interface PersistedBlueprintExtraction {
  provider: BlueprintExtractionResult["provider"];
  model: string;
  rules: unknown;
  confidence: number | null;
  sourceReferences: BlueprintSourceReferenceResult[];
  warnings: string[];
  usage: BlueprintExtractionResult["usage"];
  rawProviderResponse: unknown;
}

export function createPersistedBlueprintExtraction(result: BlueprintExtractionResult): PersistedBlueprintExtraction {
  return {
    provider: result.provider,
    model: result.model,
    rules: result.rules,
    confidence: result.confidence,
    sourceReferences: result.sourceReferences,
    warnings: result.warnings,
    usage: result.usage,
    rawProviderResponse: result.rawJson
  };
}

export function parsePersistedBlueprintExtraction(value: unknown): PersistedBlueprintExtraction {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored Blueprint extraction must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (record.provider !== "mistral") {
    throw new Error("Stored Blueprint extraction has an unsupported provider.");
  }
  if (typeof record.model !== "string" || !Array.isArray(record.sourceReferences) || !Array.isArray(record.warnings)) {
    throw new Error("Stored Blueprint extraction is missing required fields.");
  }
  if (!record.usage || typeof record.usage !== "object" || Array.isArray(record.usage)) {
    throw new Error("Stored Blueprint extraction has invalid usage metadata.");
  }
  if (record.confidence !== null && (typeof record.confidence !== "number" || !Number.isFinite(record.confidence))) {
    throw new Error("Stored Blueprint extraction has invalid confidence metadata.");
  }
  if (!Object.hasOwn(record, "rules") || !Object.hasOwn(record, "rawProviderResponse")) {
    throw new Error("Stored Blueprint extraction is missing rules or raw provider response.");
  }

  return {
    provider: record.provider,
    model: record.model,
    rules: record.rules,
    confidence: record.confidence,
    sourceReferences: record.sourceReferences as BlueprintSourceReferenceResult[],
    warnings: record.warnings as string[],
    usage: record.usage,
    rawProviderResponse: record.rawProviderResponse
  };
}

export function createBlueprintRuleExtractorFromEnv(env: NodeJS.ProcessEnv): BlueprintRuleExtractor {
  return new MistralBlueprintRuleExtractor(loadMistralConfigFromEnv(env));
}
