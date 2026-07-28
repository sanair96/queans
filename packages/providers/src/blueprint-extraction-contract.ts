import { z } from "zod";

import type { BlueprintExtractionResult } from "./types.js";

const blueprintExtractionResponseSchema = z.object({
  rules: z.unknown(),
  confidence: z.number().min(0).max(1).nullable(),
  source_references: z.array(
    z
      .object({
        page_number: z.number().int().positive(),
        language_tag: z.string().min(1).optional(),
        snippet: z.string().max(500_000).optional(),
        start_offset: z.number().int().nonnegative().optional(),
        end_offset: z.number().int().nonnegative().optional(),
        confidence: z.number().min(0).max(1).nullable().optional()
      })
      .superRefine((value, context) => {
        if ((value.start_offset === undefined) !== (value.end_offset === undefined)) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: "Source offsets must be supplied as a pair." });
        }
        if (
          value.start_offset !== undefined &&
          value.end_offset !== undefined &&
          value.end_offset < value.start_offset
        ) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: "Source end offset must not precede start offset." });
        }
      })
  ),
  warnings: z.array(z.string().max(10_000))
});

const blueprintCompletionSchema = z.object({
  choices: z.array(
    z.object({
      message: z.object({
        content: z.string()
      })
    })
  ),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      total_tokens: z.number().optional()
    })
    .optional()
});

export const blueprintExtractionJsonSchema = {
  title: "BlueprintExtraction",
  type: "object",
  additionalProperties: false,
  required: ["rules", "confidence", "source_references", "warnings"],
  properties: {
    rules: {},
    confidence: { type: ["number", "null"], minimum: 0, maximum: 1 },
    source_references: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["page_number"],
        properties: {
          page_number: { type: "integer", minimum: 1 },
          language_tag: { type: "string" },
          snippet: { type: "string" },
          start_offset: { type: "integer", minimum: 0 },
          end_offset: { type: "integer", minimum: 0 },
          confidence: { type: ["number", "null"], minimum: 0, maximum: 1 }
        }
      }
    },
    warnings: { type: "array", items: { type: "string" } }
  }
} as const;

export const blueprintExtractionSystemPrompt = [
  "Reconstruct this one blueprint document as one valid JSON value under rules. The uploaded blueprint defines the JSON structure.",
  "Preserve its native hierarchy, labels, terminology, wording, numeric values, list order, table relationships, instructions, and distinct requirements. Do not force sections, marks, question types, totals, or any universal schema.",
  "Use only the designated primary language for every textual value in rules. When a secondary-language block contains a distinct requirement, express that requirement in the primary language while retaining its original source reference. When bilingual blocks repeat the same rule, represent it once only.",
  "Strictly do not invent missing information, correct numbers without clear OCR evidence, omit alternate-language-only requirements, or put source evidence inside rules.",
  "Return source_references with page numbers for material evidence. Record uncertainty in warnings instead of fabricating values."
].join(" ");

export class BlueprintExtractionResponseError extends Error {
  constructor(
    message: string,
    readonly rawJson: unknown
  ) {
    super(message);
    this.name = "BlueprintExtractionResponseError";
  }
}

export function parseBlueprintExtractionResult(
  raw: unknown,
  model: string,
  provider: BlueprintExtractionResult["provider"]
): BlueprintExtractionResult {
  const completion = blueprintCompletionSchema.parse(raw);
  const firstChoice = completion.choices[0];
  if (!firstChoice) {
    throw new Error("Blueprint extraction returned no choices");
  }
  const extraction = blueprintExtractionResponseSchema.parse(JSON.parse(firstChoice.message.content) as unknown);
  return {
    provider,
    model,
    rules: extraction.rules,
    confidence: extraction.confidence,
    sourceReferences: extraction.source_references.map((reference) => ({
      pageNumber: reference.page_number,
      ...(reference.language_tag ? { languageTag: reference.language_tag } : {}),
      ...(reference.snippet ? { snippet: reference.snippet } : {}),
      ...(reference.start_offset !== undefined ? { startOffset: reference.start_offset } : {}),
      ...(reference.end_offset !== undefined ? { endOffset: reference.end_offset } : {}),
      ...(reference.confidence !== undefined ? { confidence: reference.confidence } : {})
    })),
    warnings: extraction.warnings,
    rawJson: raw,
    usage: {
      promptTokens: completion.usage?.prompt_tokens,
      completionTokens: completion.usage?.completion_tokens,
      totalTokens: completion.usage?.total_tokens
    }
  };
}
