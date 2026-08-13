import { z } from "zod";

import type { BlueprintExtractionResult, BlueprintSourceReferenceResult, BlueprintStructuredOcrPage } from "./types.js";

const sourcePagesSchema = z.array(z.number().int().positive()).min(1);

const markingAlternativeSchema = z.object({
  label: z.string().nullable(),
  marks: z.number().nonnegative().nullable(),
  value_points: z.array(z.string()),
  acceptable_answers: z.array(z.string()),
  marking_notes: z.array(z.string()),
  source_pages: sourcePagesSchema
}).strict();

const markingPartSchema = z.object({
  label: z.string().nullable(),
  marks: z.number().nonnegative().nullable(),
  value_points: z.array(z.string()),
  acceptable_answers: z.array(z.string()),
  marking_notes: z.array(z.string()),
  alternatives: z.array(markingAlternativeSchema),
  source_pages: sourcePagesSchema
}).strict();

const markingQuestionSchema = z.object({
  number: z.string().min(1),
  section: z.string().nullable(),
  marks: z.number().nonnegative().nullable(),
  parts: z.array(markingPartSchema),
  alternatives: z.array(markingAlternativeSchema),
  value_points: z.array(z.string()),
  acceptable_answers: z.array(z.string()),
  marking_notes: z.array(z.string()),
  source_pages: sourcePagesSchema
}).strict();

const skeletonQuestionSchema = z.object({
  number: z.string().min(1),
  section: z.string().nullable(),
  marks: z.number().nonnegative().nullable(),
  part_labels: z.array(z.string().min(1)),
  alternative_labels: z.array(z.string().min(1)),
  source_pages: sourcePagesSchema
}).strict();

export const blueprintSkeletonSchema = z.object({
  document_metadata: z.object({
    title: z.string().nullable(),
    subject: z.string().nullable(),
    examination: z.string().nullable(),
    paper_code: z.string().nullable(),
    session: z.string().nullable(),
    total_marks: z.number().nonnegative().nullable(),
    source_pages: sourcePagesSchema
  }).strict(),
  evaluation_rules: z.array(z.object({ rule: z.string().min(1), source_pages: sourcePagesSchema }).strict()),
  assessment_blueprint: z.object({
    sections: z.array(z.object({
      name: z.string().min(1),
      question_range: z.string().nullable(),
      question_type: z.string().nullable(),
      choice_rules: z.array(z.string()),
      declared_marks: z.number().nonnegative().nullable(),
      source_pages: sourcePagesSchema
    }).strict()),
    total_marks: z.number().nonnegative().nullable(),
    source_pages: sourcePagesSchema
  }).strict(),
  question_index: z.array(skeletonQuestionSchema)
}).strict();

export const questionSchemeSchema = z.object({
  question_marking_scheme: z.array(markingQuestionSchema)
}).strict();

export type BlueprintSkeleton = z.output<typeof blueprintSkeletonSchema>;
export type QuestionScheme = z.output<typeof questionSchemeSchema>;

export const markingSchemeRulesSchema = z.object({
  document_metadata: z.object({
    title: z.string().nullable(),
    subject: z.string().nullable(),
    examination: z.string().nullable(),
    paper_code: z.string().nullable(),
    session: z.string().nullable(),
    total_marks: z.number().nonnegative().nullable(),
    source_pages: sourcePagesSchema
  }).strict(),
  evaluation_rules: z.array(z.object({ rule: z.string().min(1), source_pages: sourcePagesSchema }).strict()),
  assessment_blueprint: z.object({
    sections: z.array(z.object({
      name: z.string().min(1),
      question_range: z.string().nullable(),
      question_type: z.string().nullable(),
      choice_rules: z.array(z.string()),
      declared_marks: z.number().nonnegative().nullable(),
      source_pages: sourcePagesSchema
    }).strict()),
    total_marks: z.number().nonnegative().nullable(),
    source_pages: sourcePagesSchema
  }).strict(),
  question_marking_scheme: z.array(markingQuestionSchema)
}).strict();

export type MarkingSchemeRules = z.output<typeof markingSchemeRulesSchema>;

const blueprintExtractionResponseSchema = z.object({
  rules: markingSchemeRulesSchema,
  confidence: z.number().min(0).max(1).nullable(),
  source_references: z.array(z.object({
    page_number: z.number().int().positive(),
    language_tag: z.string().min(1).optional(),
    snippet: z.string().max(500_000).optional(),
    start_offset: z.number().int().nonnegative().optional(),
    end_offset: z.number().int().nonnegative().optional(),
    confidence: z.number().min(0).max(1).nullable().optional()
  }).superRefine((value, context) => {
    if ((value.start_offset === undefined) !== (value.end_offset === undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Source offsets must be supplied as a pair." });
    }
    if (value.start_offset !== undefined && value.end_offset !== undefined && value.end_offset < value.start_offset) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Source end offset must not precede start offset." });
    }
  })),
  warnings: z.array(z.string().max(10_000))
}).strict();

const blueprintCompletionSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })),
  usage: z.object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional(), total_tokens: z.number().optional() }).optional()
});

const sourceReferenceSchema = z.object({
  page_number: z.number().int().positive(),
  language_tag: z.string().min(1).optional(),
  snippet: z.string().max(500_000).optional(),
  start_offset: z.number().int().nonnegative().optional(),
  end_offset: z.number().int().nonnegative().optional(),
  confidence: z.number().min(0).max(1).nullable().optional()
}).superRefine((value, context) => {
  if ((value.start_offset === undefined) !== (value.end_offset === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Source offsets must be supplied as a pair." });
  }
  if (value.start_offset !== undefined && value.end_offset !== undefined && value.end_offset < value.start_offset) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Source end offset must not precede start offset." });
  }
});

const extractionPassEnvelope = <TScheme extends z.ZodTypeAny>(scheme: TScheme) => z.object({
  result: scheme,
  confidence: z.number().min(0).max(1).nullable(),
  source_references: z.array(sourceReferenceSchema),
  warnings: z.array(z.string().max(10_000))
}).strict();

export const blueprintSkeletonExtractionResponseSchema = extractionPassEnvelope(blueprintSkeletonSchema);
export const questionSchemeExtractionResponseSchema = extractionPassEnvelope(questionSchemeSchema);

export interface BlueprintExtractionPassResult<T> {
  result: T;
  confidence: number | null;
  sourceReferences: BlueprintSourceReferenceResult[];
  warnings: string[];
  rawJson: unknown;
  usage: BlueprintExtractionResult["usage"];
}

const nullableString = { type: ["string", "null"] };
const sourcePagesJsonSchema = { type: "array", minItems: 1, items: { type: "integer", minimum: 1 } };
const alternativeJsonSchema = {
  type: "object", additionalProperties: false,
  required: ["label", "marks", "value_points", "acceptable_answers", "marking_notes", "source_pages"],
  properties: { label: nullableString, marks: { type: ["number", "null"], minimum: 0 }, value_points: { type: "array", items: { type: "string" } }, acceptable_answers: { type: "array", items: { type: "string" } }, marking_notes: { type: "array", items: { type: "string" } }, source_pages: sourcePagesJsonSchema }
} as const;
const partJsonSchema = { type: "object", additionalProperties: false, required: ["label", "marks", "value_points", "acceptable_answers", "marking_notes", "alternatives", "source_pages"], properties: { label: nullableString, marks: { type: ["number", "null"], minimum: 0 }, value_points: { type: "array", items: { type: "string" } }, acceptable_answers: { type: "array", items: { type: "string" } }, marking_notes: { type: "array", items: { type: "string" } }, alternatives: { type: "array", items: alternativeJsonSchema }, source_pages: sourcePagesJsonSchema } } as const;

export const blueprintExtractionJsonSchema = {
  title: "MarkingSchemeExtraction", type: "object", additionalProperties: false,
  required: ["rules", "confidence", "source_references", "warnings"],
  properties: {
    rules: { type: "object", additionalProperties: false, required: ["document_metadata", "evaluation_rules", "assessment_blueprint", "question_marking_scheme"], properties: {
      document_metadata: { type: "object", additionalProperties: false, required: ["title", "subject", "examination", "paper_code", "session", "total_marks", "source_pages"], properties: { title: nullableString, subject: nullableString, examination: nullableString, paper_code: nullableString, session: nullableString, total_marks: { type: ["number", "null"], minimum: 0 }, source_pages: sourcePagesJsonSchema } },
      evaluation_rules: { type: "array", items: { type: "object", additionalProperties: false, required: ["rule", "source_pages"], properties: { rule: { type: "string" }, source_pages: sourcePagesJsonSchema } } },
      assessment_blueprint: { type: "object", additionalProperties: false, required: ["sections", "total_marks", "source_pages"], properties: { sections: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "question_range", "question_type", "choice_rules", "declared_marks", "source_pages"], properties: { name: { type: "string" }, question_range: nullableString, question_type: nullableString, choice_rules: { type: "array", items: { type: "string" } }, declared_marks: { type: ["number", "null"], minimum: 0 }, source_pages: sourcePagesJsonSchema } } }, total_marks: { type: ["number", "null"], minimum: 0 }, source_pages: sourcePagesJsonSchema } },
      question_marking_scheme: { type: "array", items: { type: "object", additionalProperties: false, required: ["number", "section", "marks", "parts", "alternatives", "value_points", "acceptable_answers", "marking_notes", "source_pages"], properties: { number: { type: "string" }, section: nullableString, marks: { type: ["number", "null"], minimum: 0 }, parts: { type: "array", items: partJsonSchema }, alternatives: { type: "array", items: alternativeJsonSchema }, value_points: { type: "array", items: { type: "string" } }, acceptable_answers: { type: "array", items: { type: "string" } }, marking_notes: { type: "array", items: { type: "string" } }, source_pages: sourcePagesJsonSchema } } }
    } },
    confidence: { type: ["number", "null"], minimum: 0, maximum: 1 }, source_references: { type: "array", items: { type: "object", additionalProperties: false, required: ["page_number"], properties: { page_number: { type: "integer", minimum: 1 }, language_tag: { type: "string" }, snippet: { type: "string" }, start_offset: { type: "integer", minimum: 0 }, end_offset: { type: "integer", minimum: 0 }, confidence: { type: ["number", "null"], minimum: 0, maximum: 1 } } } }, warnings: { type: "array", items: { type: "string" } }
  }
} as const;

const blueprintRulesJsonSchema = blueprintExtractionJsonSchema.properties.rules;
const extractionEnvelopeJsonProperties = blueprintExtractionJsonSchema.properties;
const skeletonQuestionJsonSchema = {
  type: "object", additionalProperties: false,
  required: ["number", "section", "marks", "part_labels", "alternative_labels", "source_pages"],
  properties: {
    number: { type: "string", minLength: 1 },
    section: nullableString,
    marks: { type: ["number", "null"], minimum: 0 },
    part_labels: { type: "array", items: { type: "string", minLength: 1 } },
    alternative_labels: { type: "array", items: { type: "string", minLength: 1 } },
    source_pages: sourcePagesJsonSchema
  }
} as const;

const blueprintSkeletonJsonSchema = {
  type: "object", additionalProperties: false,
  required: ["document_metadata", "evaluation_rules", "assessment_blueprint", "question_index"],
  properties: {
    document_metadata: blueprintRulesJsonSchema.properties.document_metadata,
    evaluation_rules: blueprintRulesJsonSchema.properties.evaluation_rules,
    assessment_blueprint: blueprintRulesJsonSchema.properties.assessment_blueprint,
    question_index: { type: "array", items: skeletonQuestionJsonSchema }
  }
} as const;

const questionSchemeJsonSchema = {
  type: "object", additionalProperties: false,
  required: ["question_marking_scheme"],
  properties: {
    question_marking_scheme: blueprintRulesJsonSchema.properties.question_marking_scheme
  }
} as const;

function extractionPassJsonSchema<T extends object>(title: string, resultSchema: T) {
  return {
    title,
    type: "object",
    additionalProperties: false,
    required: ["result", "confidence", "source_references", "warnings"],
    properties: {
      result: resultSchema,
      confidence: extractionEnvelopeJsonProperties.confidence,
      source_references: extractionEnvelopeJsonProperties.source_references,
      warnings: extractionEnvelopeJsonProperties.warnings
    }
  } as const;
}

export const blueprintSkeletonExtractionJsonSchema = extractionPassJsonSchema("BlueprintSkeletonExtraction", blueprintSkeletonJsonSchema);
export const questionSchemeExtractionJsonSchema = extractionPassJsonSchema("QuestionSchemeExtraction", questionSchemeJsonSchema);

export function parseBlueprintSkeletonExtractionResult(raw: unknown): BlueprintExtractionPassResult<BlueprintSkeleton> {
  return parseExtractionPassResult(raw, blueprintSkeletonExtractionResponseSchema);
}

export function parseQuestionSchemeExtractionResult(raw: unknown): BlueprintExtractionPassResult<QuestionScheme> {
  return parseExtractionPassResult(raw, questionSchemeExtractionResponseSchema);
}

export const blueprintExtractionSystemPrompt = [
  "Extract the uploaded marking scheme, rubric, answer key, or assessment blueprint as JSON matching the supplied schema exactly: document_metadata, evaluation_rules, assessment_blueprint, and question_marking_scheme.",
  "Output ALL extracted blueprint text strictly in English. If the input paper or marking scheme is in another language (e.g. Hindi, Sanskrit, regional/foreign languages), translate the content, question text, options, answer criteria, and value points directly into accurate English so as not to lose meaning, nuance, or key evaluation details.",
  "Use document content, never its filename, for paper code and identity. Extract general evaluator guidance only into evaluation_rules.",
  "For every section, question, part, alternative, and value point, preserve marks and source_pages. Use empty arrays and null only when the source does not state a value.",
  "Do not invent answers, combine alternatives, duplicate boilerplate under each question, or include evidence snippets inside rules. Put uncertainty into warnings."
].join(" ");

const englishTranslationAndEvidenceInstructions = [
  "Output all extracted semantic text strictly in English. Translate non-English question text, options, answer criteria, value points, and evaluator guidance accurately without losing meaning.",
  "Every extracted item must include the source_pages on which it appears; never infer a page number."
].join(" ");

export const blueprintSkeletonExtractionSystemPrompt = [
  "Extract only the structural skeleton of the marking scheme as JSON matching the supplied schema exactly.",
  "Return document_metadata, evaluation_rules, assessment_blueprint, and question_index. The question_index must identify question numbers, sections, declared marks, part labels, alternative labels, and source_pages, but must not contain answer criteria or value points.",
  englishTranslationAndEvidenceInstructions,
  "Use document content, never filenames, for identity. Do not invent question numbers, ranges, marks, or choices; record uncertainty in warnings."
].join(" ");

export const questionSchemeExtractionSystemPrompt = [
  "Extract detailed question-wise marking schemes as JSON matching the supplied schema exactly.",
  "Use the supplied consolidated skeleton only as a structural guide. Extract answer criteria, value points, acceptable answers, marking notes, parts, and alternatives only when supported by the OCR page context.",
  englishTranslationAndEvidenceInstructions,
  "Do not duplicate general evaluator guidance, invent answers, merge alternatives, or omit source_pages. Record conflicts with the skeleton or uncertain OCR in warnings."
].join(" ");

export const questionSchemeRecoverySystemPrompt = [
  questionSchemeExtractionSystemPrompt,
  "This is a single targeted completeness-recovery pass. Return only the explicitly requested missing question numbers and do not repeat neighboring questions."
].join(" ");

/** Formats persisted OCR text, layout blocks, and asset metadata for either extraction pass. */
export function blueprintOcrPageContextPrompt(page: BlueprintStructuredOcrPage): string {
  const blocks = page.blocks ?? [];
  const assets = page.assets ?? [];
  return [
    `Page ${page.pageNumber}`,
    `OCR confidence: avg=${page.averageConfidence ?? "unknown"}; min=${page.minimumConfidence ?? "unknown"}`,
    `Page dimensions: width=${page.width ?? "unknown"}; height=${page.height ?? "unknown"}; dpi=${page.dpi ?? "unknown"}`,
    "Layout blocks:",
    ...(blocks.length > 0 ? blocks.map((block, index) => `${index + 1}. ${block.blockType}; confidence=${block.confidence ?? "unknown"}; text=${block.text}; bounding_box=${jsonForPrompt(block.boundingBox)}; source_asset=${jsonForPrompt(block.sourceAsset)}`) : ["- none"]),
    "Image and diagram assets (metadata only; no pixels are available):",
    ...(assets.length > 0 ? assets.map((asset, index) => `${index + 1}. id=${asset.sourceAssetId}; file=${asset.fileName}; mime_type=${asset.mimeType}; bounding_box=${jsonForPrompt(asset.boundingBox)}; metadata=${jsonForPrompt(asset.metadata)}`) : ["- none"]),
    "OCR markdown:",
    page.markdown
  ].join("\n");
}

export function blueprintSkeletonExtractionUserPrompt(input: {
  primaryLanguage: string;
  pages: BlueprintStructuredOcrPage[];
}): string {
  return [
    `Designated primary language: ${input.primaryLanguage}`,
    "OCR page context:",
    ...input.pages.map(blueprintOcrPageContextPrompt)
  ].join("\n\n");
}

export function questionSchemeExtractionUserPrompt(input: {
  primaryLanguage: string;
  skeleton: BlueprintSkeleton;
  pages: BlueprintStructuredOcrPage[];
}): string {
  return [
    `Designated primary language: ${input.primaryLanguage}`,
    "Consolidated structural skeleton (guide only):",
    jsonForPrompt(input.skeleton),
    "OCR page context:",
    ...input.pages.map(blueprintOcrPageContextPrompt)
  ].join("\n\n");
}

export function questionSchemeRecoveryUserPrompt(input: {
  primaryLanguage: string;
  skeleton: BlueprintSkeleton;
  missingQuestionNumbers: string[];
  pages: BlueprintStructuredOcrPage[];
}): string {
  return [
    `Designated primary language: ${input.primaryLanguage}`,
    `Missing question numbers to recover: ${input.missingQuestionNumbers.join(", ")}`,
    "Return detailed schemes only for those missing question numbers when supported by the supplied evidence.",
    "Consolidated structural skeleton (guide only):",
    jsonForPrompt(input.skeleton),
    "Affected and adjacent OCR page context:",
    ...input.pages.map(blueprintOcrPageContextPrompt)
  ].join("\n\n");
}

function jsonForPrompt(value: unknown) {
  if (value === undefined || value === null) return "null";
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable metadata]";
  }
}

export class BlueprintExtractionResponseError extends Error {
  constructor(message: string, readonly rawJson: unknown) { super(message); this.name = "BlueprintExtractionResponseError"; }
}

export function mergeMarkingSchemeRules(results: MarkingSchemeRules[]): MarkingSchemeRules {
  const first = results[0];
  if (!first) throw new Error("No marking-scheme extraction chunks were returned.");
  const unique = <T>(values: T[], key: (value: T) => string) => values.filter((value, index) => values.findIndex((candidate) => key(candidate) === key(value)) === index);
  return markingSchemeRulesSchema.parse({
    document_metadata: first.document_metadata,
    evaluation_rules: unique(results.flatMap((result) => result.evaluation_rules), (rule) => `${rule.rule}|${rule.source_pages.join(",")}`),
    assessment_blueprint: { ...first.assessment_blueprint, sections: unique(results.flatMap((result) => result.assessment_blueprint.sections), (section) => `${section.name}|${section.question_range ?? ""}`) },
    question_marking_scheme: unique(results.flatMap((result) => result.question_marking_scheme), (question) => question.number)
  });
}

export function consolidateBlueprintSkeletons(results: BlueprintSkeleton[]): { skeleton: BlueprintSkeleton; warnings: string[] } {
  const first = results[0];
  if (!first) throw new Error("No Blueprint skeleton chunks were returned.");
  const warnings: string[] = [];
  const metadata = results.map((result) => result.document_metadata);
  const pickMetadata = <T extends string | number>(field: keyof BlueprintSkeleton["document_metadata"]) => {
    const values = metadata.map((item) => item[field]).filter((value): value is T => value !== null);
    if (new Set(values.map(String)).size > 1) warnings.push(`Conflicting skeleton document metadata for ${field}; retained the earliest value.`);
    return values[0] ?? null;
  };
  const unionPages = (...pages: number[][]) => [...new Set(pages.flat())].sort((a, b) => a - b);
  const rules = new Map<string, BlueprintSkeleton["evaluation_rules"][number]>();
  const sections = new Map<string, BlueprintSkeleton["assessment_blueprint"]["sections"][number]>();
  const questions = new Map<string, BlueprintSkeleton["question_index"][number]>();
  for (const result of results) {
    for (const rule of result.evaluation_rules) {
      const key = rule.rule.trim().toLocaleLowerCase();
      const previous = rules.get(key);
      rules.set(key, previous ? { ...previous, source_pages: unionPages(previous.source_pages, rule.source_pages) } : rule);
    }
    for (const section of result.assessment_blueprint.sections) {
      const key = `${section.name.trim().toLocaleLowerCase()}|${section.question_range ?? ""}`;
      const previous = sections.get(key);
      if (previous && (previous.question_type !== section.question_type || previous.declared_marks !== section.declared_marks)) {
        warnings.push(`Conflicting skeleton section evidence for ${section.name}; retained the earliest declaration.`);
      }
      sections.set(key, previous ? { ...previous, choice_rules: uniqueStrings([...previous.choice_rules, ...section.choice_rules]), source_pages: unionPages(previous.source_pages, section.source_pages) } : section);
    }
    for (const question of result.question_index) {
      const previous = questions.get(question.number);
      if (previous && (previous.section !== question.section || previous.marks !== question.marks)) {
        warnings.push(`Conflicting skeleton question evidence for ${question.number}; retained the earliest declaration.`);
      }
      questions.set(question.number, previous ? {
        ...previous,
        part_labels: uniqueStrings([...previous.part_labels, ...question.part_labels]),
        alternative_labels: uniqueStrings([...previous.alternative_labels, ...question.alternative_labels]),
        source_pages: unionPages(previous.source_pages, question.source_pages)
      } : question);
    }
  }
  return {
    skeleton: blueprintSkeletonSchema.parse({
      document_metadata: {
        title: pickMetadata<string>("title"), subject: pickMetadata<string>("subject"), examination: pickMetadata<string>("examination"),
        paper_code: pickMetadata<string>("paper_code"), session: pickMetadata<string>("session"), total_marks: pickMetadata<number>("total_marks"),
        source_pages: unionPages(...metadata.map((item) => item.source_pages))
      },
      evaluation_rules: [...rules.values()],
      assessment_blueprint: {
        sections: [...sections.values()],
        total_marks: first.assessment_blueprint.total_marks,
        source_pages: unionPages(...results.map((result) => result.assessment_blueprint.source_pages))
      },
      question_index: [...questions.values()]
    }),
    warnings
  };
}

export function mergeQuestionSchemesWithEvidence(results: QuestionScheme[]): { questionMarkingScheme: MarkingSchemeRules["question_marking_scheme"]; warnings: string[] } {
  const warnings: string[] = [];
  const questions = new Map<string, MarkingSchemeRules["question_marking_scheme"][number]>();
  for (const question of results.flatMap((result) => result.question_marking_scheme)) {
    const previous = questions.get(question.number);
    questions.set(question.number, previous ? mergeQuestionEvidence(previous, question, warnings) : question);
  }
  return {
    questionMarkingScheme: [...questions.values()].sort((left, right) => left.number.localeCompare(right.number, undefined, { numeric: true })),
    warnings
  };
}

function mergeQuestionEvidence(
  first: MarkingSchemeRules["question_marking_scheme"][number],
  next: MarkingSchemeRules["question_marking_scheme"][number],
  warnings: string[]
) {
  const number = first.number;
  const retain = <T extends string | number>(field: string, left: T | null, right: T | null): T | null => {
    if (left !== null && right !== null && left !== right) warnings.push(`Conflicting evidence for question ${number} ${field}; retained the earliest value.`);
    return left ?? right;
  };
  const pages = (...values: number[][]) => [...new Set(values.flat())].sort((a, b) => a - b);
  return {
    ...first,
    section: retain("section", first.section, next.section),
    marks: retain("marks", first.marks, next.marks),
    value_points: uniqueStrings([...first.value_points, ...next.value_points]),
    acceptable_answers: uniqueStrings([...first.acceptable_answers, ...next.acceptable_answers]),
    marking_notes: uniqueStrings([...first.marking_notes, ...next.marking_notes]),
    alternatives: mergeEvidenceItems(first.alternatives, next.alternatives, pages),
    parts: mergeParts(first.parts, next.parts, pages),
    source_pages: pages(first.source_pages, next.source_pages)
  };
}

function mergeParts<T extends { label: string | null; value_points: string[]; acceptable_answers: string[]; marking_notes: string[]; alternatives: Array<{ label: string | null; source_pages: number[] }>; source_pages: number[] }>(first: T[], next: T[], pages: (...values: number[][]) => number[]) {
  const values = new Map<string, T>();
  for (const part of [...first, ...next]) {
    const key = part.label ?? `position-${values.size}`;
    const previous = values.get(key);
    values.set(key, previous ? { ...previous, value_points: uniqueStrings([...previous.value_points, ...part.value_points]), acceptable_answers: uniqueStrings([...previous.acceptable_answers, ...part.acceptable_answers]), marking_notes: uniqueStrings([...previous.marking_notes, ...part.marking_notes]), alternatives: mergeEvidenceItems(previous.alternatives, part.alternatives, pages), source_pages: pages(previous.source_pages, part.source_pages) } : part);
  }
  return [...values.values()];
}

function mergeEvidenceItems<T extends { label: string | null; source_pages: number[] }>(first: T[], next: T[], pages: (...values: number[][]) => number[]) {
  const values = new Map<string, T>();
  for (const item of [...first, ...next]) {
    const key = item.label ?? `position-${values.size}`;
    const previous = values.get(key);
    values.set(key, previous ? { ...previous, source_pages: pages(previous.source_pages, item.source_pages) } : item);
  }
  return [...values.values()];
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function parseExtractionPassResult<T>(
  raw: unknown,
  schema: z.ZodType<{ result: T; confidence: number | null; source_references: z.infer<typeof sourceReferenceSchema>[]; warnings: string[] }>
): BlueprintExtractionPassResult<T> {
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
  return { provider, model, rules: extraction.rules, confidence: extraction.confidence, sourceReferences: extraction.source_references.map((reference) => ({ pageNumber: reference.page_number, ...(reference.language_tag ? { languageTag: reference.language_tag } : {}), ...(reference.snippet ? { snippet: reference.snippet } : {}), ...(reference.start_offset !== undefined ? { startOffset: reference.start_offset } : {}), ...(reference.end_offset !== undefined ? { endOffset: reference.end_offset } : {}), ...(reference.confidence !== undefined ? { confidence: reference.confidence } : {}) })), warnings: extraction.warnings, rawJson: raw, usage: { promptTokens: completion.usage?.prompt_tokens, completionTokens: completion.usage?.completion_tokens, totalTokens: completion.usage?.total_tokens } };
}
