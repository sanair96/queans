import { loadMistralConfigFromEnv, MistralQuestionExtractor } from "./mistral.js";
import type { ExtractedQuestionCandidate, OcrPage, QuestionExtractionResult, QuestionSolvingResult } from "./types.js";

export const supportedQuestionExtractorProviders = ["mistral"] as const;

export type QuestionExtractorProvider = (typeof supportedQuestionExtractorProviders)[number];

export interface QuestionExtractor {
  extractFromPages(pages: OcrPage[]): Promise<QuestionExtractionResult>;
  solveCandidate(
    candidate: ExtractedQuestionCandidate,
    imageUrls: Array<{ url: string; label: string }>
  ): Promise<QuestionSolvingResult>;
}

export function loadQuestionExtractorProviderFromEnv(env: NodeJS.ProcessEnv): QuestionExtractorProvider {
  const provider = env.LLM_PROVIDER?.trim().toLowerCase() || "mistral";
  if (isQuestionExtractorProvider(provider)) {
    return provider;
  }

  throw new Error(
    `Unsupported LLM_PROVIDER: ${provider}. Supported providers: ${supportedQuestionExtractorProviders.join(", ")}`
  );
}

export function createQuestionExtractorFromEnv(env: NodeJS.ProcessEnv): QuestionExtractor {
  const provider = loadQuestionExtractorProviderFromEnv(env);
  switch (provider) {
    case "mistral":
      return new MistralQuestionExtractor(loadMistralConfigFromEnv(env));
  }
}

function isQuestionExtractorProvider(provider: string): provider is QuestionExtractorProvider {
  return supportedQuestionExtractorProviders.some((supportedProvider) => supportedProvider === provider);
}
