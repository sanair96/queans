import { z } from "zod";

import type { BlueprintExtractionResult } from "./types.js";

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

export const blueprintExtractionSystemPrompt = [
  "Extract the uploaded marking scheme, rubric, answer key, or assessment blueprint as JSON matching the supplied schema exactly: document_metadata, evaluation_rules, assessment_blueprint, and question_marking_scheme.",
  "Use document content, never its filename, for paper code and identity. Extract general evaluator guidance only into evaluation_rules.",
  "For every section, question, part, alternative, and value point, preserve marks and source_pages. Use empty arrays and null only when the source does not state a value.",
  "Do not invent answers, combine alternatives, duplicate boilerplate under each question, or include evidence snippets inside rules. Put uncertainty into warnings."
].join(" ");

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

export function parseBlueprintExtractionResult(raw: unknown, model: string, provider: BlueprintExtractionResult["provider"]): BlueprintExtractionResult {
  const completion = blueprintCompletionSchema.parse(raw);
  const firstChoice = completion.choices[0];
  if (!firstChoice) throw new Error("Blueprint extraction returned no choices");
  const extraction = blueprintExtractionResponseSchema.parse(JSON.parse(firstChoice.message.content) as unknown);
  return { provider, model, rules: extraction.rules, confidence: extraction.confidence, sourceReferences: extraction.source_references.map((reference) => ({ pageNumber: reference.page_number, ...(reference.language_tag ? { languageTag: reference.language_tag } : {}), ...(reference.snippet ? { snippet: reference.snippet } : {}), ...(reference.start_offset !== undefined ? { startOffset: reference.start_offset } : {}), ...(reference.end_offset !== undefined ? { endOffset: reference.end_offset } : {}), ...(reference.confidence !== undefined ? { confidence: reference.confidence } : {}) })), warnings: extraction.warnings, rawJson: raw, usage: { promptTokens: completion.usage?.prompt_tokens, completionTokens: completion.usage?.completion_tokens, totalTokens: completion.usage?.total_tokens } };
}
