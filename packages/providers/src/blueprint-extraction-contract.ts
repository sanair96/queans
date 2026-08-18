import { z } from "zod";

import type { BlueprintExtractionResult, BlueprintSourceReferenceResult, BlueprintStructuredOcrPage } from "./types.js";

const sourcePagesSchema = z.array(z.number().int().positive()).min(1);

const questionIndexEntrySchema = z.object({
  number: z.string().min(1),
  section: z.string().nullable(),
  marks: z.number().nonnegative().nullable(),
  question_type: z.string().nullable(),
  part_labels: z.array(z.string().min(1)),
  alternative_labels: z.array(z.string().min(1)),
  source_pages: sourcePagesSchema
}).strict();

const structuralBlueprintSchema = z.object({
  document_metadata: z.object({
    title: z.string().nullable(), subject: z.string().nullable(), examination: z.string().nullable(), paper_code: z.string().nullable(), session: z.string().nullable(), total_marks: z.number().nonnegative().nullable(), source_pages: sourcePagesSchema
  }).strict(),
  evaluation_rules: z.array(z.object({ rule: z.string().min(1), source_pages: sourcePagesSchema }).strict()),
  assessment_blueprint: z.object({
    sections: z.array(z.object({ name: z.string().min(1), printed_identifier: z.string().nullable(), question_range: z.string().nullable(), question_type: z.string().nullable(), choice_rules: z.array(z.string()), declared_marks: z.number().nonnegative().nullable(), source_pages: sourcePagesSchema }).strict()),
    total_marks: z.number().nonnegative().nullable(), source_pages: sourcePagesSchema
  }).strict(),
  question_index: z.array(questionIndexEntrySchema)
}).strict();

export const blueprintSkeletonSchema = structuralBlueprintSchema;
export const blueprintRulesSchema = structuralBlueprintSchema;
export const markingSchemeRulesSchema = structuralBlueprintSchema;

export type BlueprintSkeleton = z.output<typeof blueprintSkeletonSchema>;
export type BlueprintRules = z.output<typeof blueprintRulesSchema>;
export type MarkingSchemeRules = BlueprintRules;
export type BlueprintQuestionIndexEntry = BlueprintRules["question_index"][number];
export type QuestionScheme = { question_index: BlueprintQuestionIndexEntry[] };

const sourceReferenceSchema = z.object({
  page_number: z.number().int().positive(), language_tag: z.string().min(1).optional(), snippet: z.string().max(500_000).optional(), start_offset: z.number().int().nonnegative().optional(), end_offset: z.number().int().nonnegative().optional(), confidence: z.number().min(0).max(1).nullable().optional()
}).superRefine((value, context) => {
  if ((value.start_offset === undefined) !== (value.end_offset === undefined)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Source offsets must be supplied as a pair." });
  if (value.start_offset !== undefined && value.end_offset !== undefined && value.end_offset < value.start_offset) context.addIssue({ code: z.ZodIssueCode.custom, message: "Source end offset must not precede start offset." });
});

const blueprintCompletionSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })),
  usage: z.object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional(), total_tokens: z.number().optional() }).optional()
});

const blueprintExtractionResponseSchema = z.object({
  rules: structuralBlueprintSchema,
  confidence: z.number().min(0).max(1).nullable(),
  source_references: z.array(sourceReferenceSchema),
  warnings: z.array(z.string().max(10_000))
}).strict();

const extractionPassEnvelope = <TScheme extends z.ZodTypeAny>(scheme: TScheme) => z.object({
  result: scheme, confidence: z.number().min(0).max(1).nullable(), source_references: z.array(sourceReferenceSchema), warnings: z.array(z.string().max(10_000))
}).strict();

export const blueprintSkeletonExtractionResponseSchema = extractionPassEnvelope(structuralBlueprintSchema);
export const blueprintSkeletonRecoveryResponseSchema = extractionPassEnvelope(z.object({ question_index: z.array(questionIndexEntrySchema) }).strict());

export interface BlueprintExtractionPassResult<T> {
  result: T;
  confidence: number | null;
  sourceReferences: BlueprintSourceReferenceResult[];
  warnings: string[];
  rawJson: unknown;
  usage: BlueprintExtractionResult["usage"];
}

export type BlueprintSkeletonRecovery = z.output<typeof blueprintSkeletonRecoveryResponseSchema>["result"];

const nullableString = { type: ["string", "null"] } as const;
const sourcePagesJsonSchema = { type: "array", minItems: 1, items: { type: "integer", minimum: 1 } } as const;
const questionIndexJsonSchema = {
  type: "object", additionalProperties: false,
  required: ["number", "section", "marks", "question_type", "part_labels", "alternative_labels", "source_pages"],
  properties: { number: { type: "string", minLength: 1 }, section: nullableString, marks: { type: ["number", "null"], minimum: 0 }, question_type: nullableString, part_labels: { type: "array", items: { type: "string", minLength: 1 } }, alternative_labels: { type: "array", items: { type: "string", minLength: 1 } }, source_pages: sourcePagesJsonSchema }
} as const;
const structuralJsonSchema = {
  type: "object", additionalProperties: false,
  required: ["document_metadata", "evaluation_rules", "assessment_blueprint", "question_index"],
  properties: {
    document_metadata: { type: "object", additionalProperties: false, required: ["title", "subject", "examination", "paper_code", "session", "total_marks", "source_pages"], properties: { title: nullableString, subject: nullableString, examination: nullableString, paper_code: nullableString, session: nullableString, total_marks: { type: ["number", "null"], minimum: 0 }, source_pages: sourcePagesJsonSchema } },
    evaluation_rules: { type: "array", items: { type: "object", additionalProperties: false, required: ["rule", "source_pages"], properties: { rule: { type: "string" }, source_pages: sourcePagesJsonSchema } } },
    assessment_blueprint: { type: "object", additionalProperties: false, required: ["sections", "total_marks", "source_pages"], properties: { sections: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "printed_identifier", "question_range", "question_type", "choice_rules", "declared_marks", "source_pages"], properties: { name: { type: "string" }, printed_identifier: nullableString, question_range: nullableString, question_type: nullableString, choice_rules: { type: "array", items: { type: "string" } }, declared_marks: { type: ["number", "null"], minimum: 0 }, source_pages: sourcePagesJsonSchema } } }, total_marks: { type: ["number", "null"], minimum: 0 }, source_pages: sourcePagesJsonSchema } },
    question_index: { type: "array", items: questionIndexJsonSchema }
  }
} as const;

export const blueprintExtractionJsonSchema = {
  title: "StructuralBlueprintExtraction", type: "object", additionalProperties: false,
  required: ["rules", "confidence", "source_references", "warnings"],
  properties: { rules: structuralJsonSchema, confidence: { type: ["number", "null"], minimum: 0, maximum: 1 }, source_references: { type: "array", items: { type: "object", additionalProperties: false, required: ["page_number"], properties: { page_number: { type: "integer", minimum: 1 }, language_tag: { type: "string" }, snippet: { type: "string" }, start_offset: { type: "integer", minimum: 0 }, end_offset: { type: "integer", minimum: 0 }, confidence: { type: ["number", "null"], minimum: 0, maximum: 1 } } } }, warnings: { type: "array", items: { type: "string" } } }
} as const;

const blueprintSkeletonJsonSchema = structuralJsonSchema;

function extractionPassJsonSchema<T extends object>(title: string, resultSchema: T) {
  return { title, type: "object", additionalProperties: false, required: ["result", "confidence", "source_references", "warnings"], properties: { result: resultSchema, confidence: { type: ["number", "null"], minimum: 0, maximum: 1 }, source_references: { type: "array", items: { type: "object", additionalProperties: false, required: ["page_number"], properties: { page_number: { type: "integer", minimum: 1 }, language_tag: { type: "string" }, snippet: { type: "string" }, start_offset: { type: "integer", minimum: 0 }, end_offset: { type: "integer", minimum: 0 }, confidence: { type: ["number", "null"], minimum: 0, maximum: 1 } } } }, warnings: { type: "array", items: { type: "string" } } } } as const;
}

export const blueprintSkeletonExtractionJsonSchema = extractionPassJsonSchema("StructuralBlueprintExtraction", blueprintSkeletonJsonSchema);
export const blueprintSkeletonRecoveryJsonSchema = extractionPassJsonSchema("StructuralBlueprintRecovery", { type: "object", additionalProperties: false, required: ["question_index"], properties: { question_index: { type: "array", items: questionIndexJsonSchema } } });

export function parseBlueprintSkeletonExtractionResult(raw: unknown): BlueprintExtractionPassResult<BlueprintSkeleton> {
  return parseExtractionPassResult(raw, blueprintSkeletonExtractionResponseSchema);
}

export function parseBlueprintSkeletonRecoveryResult(raw: unknown): BlueprintExtractionPassResult<BlueprintSkeletonRecovery> {
  return parseExtractionPassResult(raw, blueprintSkeletonRecoveryResponseSchema);
}

export function blueprintOcrPageContextPrompt(page: BlueprintStructuredOcrPage): string {
  const blocks = page.blocks ?? [];
  const assets = page.assets ?? [];
  return [`Page ${page.pageNumber}`, `OCR confidence: avg=${page.averageConfidence ?? "unknown"}; min=${page.minimumConfidence ?? "unknown"}`, `Page dimensions: width=${page.width ?? "unknown"}; height=${page.height ?? "unknown"}; dpi=${page.dpi ?? "unknown"}`, "Layout blocks:", ...(blocks.length > 0 ? blocks.map((block, index) => `${index + 1}. ${block.blockType}; confidence=${block.confidence ?? "unknown"}; text=${block.text}; bounding_box=${jsonForPrompt(block.boundingBox)}; source_asset=${jsonForPrompt(block.sourceAsset)}`) : ["- none"]), "Image and diagram assets (metadata only; no pixels are available):", ...(assets.length > 0 ? assets.map((asset, index) => `${index + 1}. id=${asset.sourceAssetId}; file=${asset.fileName}; mime_type=${asset.mimeType}; bounding_box=${jsonForPrompt(asset.boundingBox)}; metadata=${jsonForPrompt(asset.metadata)}`) : ["- none"]), "OCR markdown:", page.markdown].join("\n");
}

export const blueprintSkeletonExtractionSystemPrompt = [
  "Extract only the structural Blueprint of the uploaded question paper or marking scheme.",
  "Return document_metadata, evaluation_rules, assessment_blueprint, and question_index matching the schema exactly.",
  "question_index must contain exactly one entry for each top-level numbered question, with its section, marks, question type, part labels, alternative labels, and source_pages.",
  "Do not create separate question_index entries for subquestions such as 1(a), 1(b), or Q1(ii); attach those labels to the parent question's part_labels or alternative_labels.",
  "Never return question text, question stems, options, answers, value points, acceptable answers, marking notes, or translated question prose.",
  "Preserve structural labels and rules in the source language when visible. Do not invent missing numbers, marks, ranges, sections, or choices; report uncertainty in warnings.",
  "Use all OCR pages as evidence, including tables, layout blocks, and diagram metadata. Return only the requested JSON."
].join(" ");

export function blueprintSkeletonExtractionUserPrompt(input: { primaryLanguage: string; pages: BlueprintStructuredOcrPage[] }): string {
  return [`Detected primary language: ${input.primaryLanguage}`, "Structural-only extraction is required. Do not copy any question prose.", "OCR page context:", ...input.pages.map(blueprintOcrPageContextPrompt)].join("\n\n");
}

export function blueprintSkeletonRecoveryUserPrompt(input: { primaryLanguage: string; missingQuestionNumbers: string[]; pages: BlueprintStructuredOcrPage[] }): string {
  return [`Detected primary language: ${input.primaryLanguage}`, `Recover only these missing structural question numbers: ${input.missingQuestionNumbers.join(", ")}`, "Return question_index entries only. Do not return question text, answers, options, or marking criteria.", "OCR page context:", ...input.pages.map(blueprintOcrPageContextPrompt)].join("\n\n");
}

function jsonForPrompt(value: unknown) {
  if (value === undefined || value === null) return "null";
  try { return JSON.stringify(value); } catch { return "[unserializable metadata]"; }
}

export class BlueprintExtractionResponseError extends Error {
  constructor(message: string, readonly rawJson: unknown) { super(message); this.name = "BlueprintExtractionResponseError"; }
}

export function consolidateBlueprintSkeletons(results: BlueprintSkeleton[]): { skeleton: BlueprintSkeleton; warnings: string[] } {
  const first = results[0];
  if (!first) throw new Error("No Blueprint skeleton chunks were returned.");
  const warnings: string[] = [];
  const unionPages = (...pages: number[][]) => [...new Set(pages.flat())].sort((a, b) => a - b);
  const uniqueStrings = (values: string[]) => [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  const metadata = results.map((result) => result.document_metadata);
  const pickMetadata = <T extends string | number>(field: keyof BlueprintSkeleton["document_metadata"]) => {
    const values = metadata.map((item) => item[field]).filter((value): value is T => value !== null);
    if (new Set(values.map(String)).size > 1) warnings.push(`Conflicting document metadata for ${field}; retained the earliest value.`);
    return values[0] ?? null;
  };
  const rules = new Map<string, BlueprintSkeleton["evaluation_rules"][number]>();
  const sections = new Map<string, BlueprintSkeleton["assessment_blueprint"]["sections"][number]>();
  const questions = new Map<string, BlueprintQuestionIndexEntry>();
  for (const result of results) {
    for (const rule of result.evaluation_rules) {
      const key = rule.rule.trim().toLocaleLowerCase();
      const previous = rules.get(key);
      rules.set(key, previous ? { ...previous, source_pages: unionPages(previous.source_pages, rule.source_pages) } : rule);
    }
    for (const section of result.assessment_blueprint.sections) {
      const key = sectionIdentityKey(section);
      const previous = sections.get(key);
      if (previous && (previous.question_type !== section.question_type || previous.declared_marks !== section.declared_marks)) warnings.push(`Conflicting section evidence for ${section.name}; retained the earliest declaration.`);
      sections.set(key, previous ? { ...previous, choice_rules: uniqueStrings([...previous.choice_rules, ...section.choice_rules]), source_pages: unionPages(previous.source_pages, section.source_pages) } : section);
    }
    for (const question of result.question_index) {
      const key = canonicalQuestionNumber(question.number);
      const previous = questions.get(key);
      if (previous && (previous.section !== question.section || previous.marks !== question.marks || previous.question_type !== question.question_type)) warnings.push(`Conflicting question evidence for ${question.number}; retained the earliest scalar fields.`);
      questions.set(key, previous ? { ...previous, part_labels: uniqueStrings([...previous.part_labels, ...question.part_labels]), alternative_labels: uniqueStrings([...previous.alternative_labels, ...question.alternative_labels]), source_pages: unionPages(previous.source_pages, question.source_pages) } : question);
    }
  }
  return { skeleton: structuralBlueprintSchema.parse({ document_metadata: { title: pickMetadata<string>("title"), subject: pickMetadata<string>("subject"), examination: pickMetadata<string>("examination"), paper_code: pickMetadata<string>("paper_code"), session: pickMetadata<string>("session"), total_marks: pickMetadata<number>("total_marks"), source_pages: unionPages(...metadata.map((item) => item.source_pages)) }, evaluation_rules: [...rules.values()], assessment_blueprint: { sections: [...sections.values()], total_marks: first.assessment_blueprint.total_marks, source_pages: unionPages(...results.map((result) => result.assessment_blueprint.source_pages)) }, question_index: [...questions.values()].sort((left, right) => compareQuestionNumbers(left.number, right.number)) }), warnings };
}

function sectionIdentityKey(section: BlueprintSkeleton["assessment_blueprint"]["sections"][number]) {
  return `${normalizeSectionName(section.name)}|${normalizeQuestionRange(section.question_range)}`;
}

function normalizeSectionName(value: string) {
  return value.trim().toLocaleLowerCase().replace(/\s+/gu, " ");
}

function normalizeQuestionRange(value: string | null) {
  if (value === null) return "";
  const normalized = value.replace(/[–—]/gu, "-").trim();
  const tokens = normalized.split(",").map((token) => token.trim()).filter(Boolean);
  if (tokens.length === 0 || !tokens.every((token) => /^\d+(?:\s*-\s*\d+)?$/u.test(token))) {
    return normalized.toLocaleLowerCase().replace(/\s+/gu, " ");
  }

  const numbers = new Set<number>();
  for (const token of tokens) {
    const [startText, endText] = token.split("-");
    const start = Number(startText!.trim());
    const end = endText === undefined ? start : Number(endText.trim());
    if (end < start) return normalized.toLocaleLowerCase().replace(/\s+/gu, " ");
    for (let number = start; number <= end; number += 1) numbers.add(number);
  }
  return [...numbers].sort((left, right) => left - right).join(",");
}

function canonicalQuestionNumber(value: string) {
  const trimmed = value.trim();
  return /^\d+$/u.test(trimmed) ? String(Number(trimmed)) : trimmed;
}

function compareQuestionNumbers(left: string, right: string) {
  const leftNumber = /^\d+$/u.test(left) ? Number(left) : Number.NaN;
  const rightNumber = /^\d+$/u.test(right) ? Number(right) : Number.NaN;
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
  if (Number.isFinite(leftNumber)) return -1;
  if (Number.isFinite(rightNumber)) return 1;
  return left.localeCompare(right, undefined, { numeric: true });
}

function parseExtractionPassResult<T>(raw: unknown, schema: z.ZodType<{ result: T; confidence: number | null; source_references: z.infer<typeof sourceReferenceSchema>[]; warnings: string[] }>): BlueprintExtractionPassResult<T> {
  const completion = blueprintCompletionSchema.parse(raw);
  const firstChoice = completion.choices[0];
  if (!firstChoice) throw new Error("Blueprint extraction returned no choices");
  const extraction = schema.parse(JSON.parse(firstChoice.message.content) as unknown);
  return { result: extraction.result, confidence: extraction.confidence, sourceReferences: mapSourceReferences(extraction.source_references), warnings: extraction.warnings, rawJson: raw, usage: { promptTokens: completion.usage?.prompt_tokens, completionTokens: completion.usage?.completion_tokens, totalTokens: completion.usage?.total_tokens } };
}

function mapSourceReferences(references: z.infer<typeof sourceReferenceSchema>[]): BlueprintSourceReferenceResult[] {
  return references.map((reference) => ({ pageNumber: reference.page_number, ...(reference.language_tag ? { languageTag: reference.language_tag } : {}), ...(reference.snippet ? { snippet: reference.snippet } : {}), ...(reference.start_offset !== undefined ? { startOffset: reference.start_offset } : {}), ...(reference.end_offset !== undefined ? { endOffset: reference.end_offset } : {}), ...(reference.confidence !== undefined ? { confidence: reference.confidence } : {}) }));
}

export function parseBlueprintExtractionResult(raw: unknown, model: string, provider: BlueprintExtractionResult["provider"]): BlueprintExtractionResult {
  const completion = blueprintCompletionSchema.parse(raw);
  const firstChoice = completion.choices[0];
  if (!firstChoice) throw new Error("Blueprint extraction returned no choices");
  const extraction = blueprintExtractionResponseSchema.parse(JSON.parse(firstChoice.message.content) as unknown);
  return { provider, model, rules: extraction.rules, confidence: extraction.confidence, sourceReferences: mapSourceReferences(extraction.source_references), warnings: extraction.warnings, rawJson: raw, usage: { promptTokens: completion.usage?.prompt_tokens, completionTokens: completion.usage?.completion_tokens, totalTokens: completion.usage?.total_tokens } };
}
