import { z } from "zod";

import type { ExtractedQuestionCandidate, OcrPage, OcrResult, QuestionExtractionResult } from "./types.js";

export interface MistralConfig {
  apiKey: string;
  ocrModel: string;
  extractorModel: string;
}

export function loadMistralConfigFromEnv(env: NodeJS.ProcessEnv): MistralConfig {
  return {
    apiKey: requiredEnv(env, "MISTRAL_API_KEY"),
    ocrModel: env.MISTRAL_OCR_MODEL?.trim() || "mistral-ocr-latest",
    extractorModel: env.EXTRACTOR_MODEL?.trim() || "mistral-small-latest"
  };
}

const mistralOcrPageSchema = z.object({
  index: z.number(),
  markdown: z.string(),
  images: z.array(z.unknown()).optional(),
  tables: z.array(z.unknown()).optional(),
  dimensions: z
    .object({
      dpi: z.number().optional(),
      height: z.number().optional(),
      width: z.number().optional()
    })
    .optional(),
  confidence_scores: z
    .object({
      average_page_confidence_score: z.number().optional(),
      minimum_page_confidence_score: z.number().optional()
    })
    .nullable()
    .optional()
});

const mistralOcrResponseSchema = z.object({
  pages: z.array(mistralOcrPageSchema),
  model: z.string(),
  usage_info: z
    .object({
      pages_processed: z.number().optional(),
      doc_size_bytes: z.number().optional()
    })
    .optional()
});

const extractionCandidateSchema = z.object({
  question_number: z.string().optional(),
  section_name: z.string().optional(),
  page_number: z.number().optional(),
  source_page_start: z.number().optional(),
  source_page_end: z.number().optional(),
  raw_ocr_text: z.string(),
  cleaned_question_text: z.string(),
  question_type: z.string(),
  marks: z.number().optional(),
  options: z.unknown().optional(),
  answer_text: z.string().optional(),
  solution_text: z.string().optional(),
  answer_source_type: z.enum(["SOURCE_KEY", "LLM_GENERATED"]).default("LLM_GENERATED"),
  answer_source_backed: z.boolean().default(false),
  chapter: z.string().optional(),
  topic: z.string().optional(),
  subtopic: z.string().optional(),
  difficulty: z.string().optional(),
  bloom_level: z.string().optional(),
  requires_diagram: z.boolean().default(false),
  diagram_asset: z.unknown().optional(),
  field_confidence: z.record(z.number()),
  overall_confidence: z.number(),
  validation_errors: z.array(z.string()),
  source_evidence: z.unknown()
});

const extractionResponseSchema = z.object({
  candidates: z.array(extractionCandidateSchema)
});

const extractionValidationReasonCodes = [
  "LOW_OCR_CONFIDENCE",
  "MISSING_REQUIRED_FIELD",
  "LOW_FIELD_CONFIDENCE",
  "VALIDATION_FAILED",
  "DUPLICATE_CONFLICT",
  "ANSWER_UNCERTAIN",
  "MATH_OR_DIAGRAM_UNCERTAIN",
  "TOPIC_AMBIGUOUS",
  "CONTRADICTION_DETECTED",
  "MISSING_QUESTION_TEXT",
  "MISSING_MARKS",
  "MCQ_OPTIONS_MISSING",
  "MCQ_CORRECT_ANSWER_MISSING",
  "TOPIC_NOT_MAPPED",
  "LOW_ANSWER_CONFIDENCE",
  "DIAGRAM_ASSET_MISSING",
  "LLM_GENERATED_ANSWER_UNVERIFIED",
  "LOW_TOPIC_CONFIDENCE"
] as const;

const extractionResponseJsonSchema = {
  title: "QuestionCandidates",
  type: "object",
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      items: {
        title: "QuestionCandidate",
        type: "object",
        additionalProperties: false,
        required: [
          "raw_ocr_text",
          "cleaned_question_text",
          "question_type",
          "answer_source_type",
          "answer_source_backed",
          "requires_diagram",
          "field_confidence",
          "overall_confidence",
          "validation_errors",
          "source_evidence"
        ],
        properties: {
          question_number: { type: "string" },
          section_name: { type: "string" },
          page_number: { type: "number" },
          source_page_start: { type: "number" },
          source_page_end: { type: "number" },
          raw_ocr_text: { type: "string" },
          cleaned_question_text: { type: "string" },
          question_type: { type: "string" },
          marks: { type: "number" },
          options: {},
          answer_text: { type: "string" },
          solution_text: { type: "string" },
          answer_source_type: { type: "string", enum: ["SOURCE_KEY", "LLM_GENERATED"] },
          answer_source_backed: { type: "boolean" },
          chapter: { type: "string" },
          topic: { type: "string" },
          subtopic: { type: "string" },
          difficulty: { type: "string" },
          bloom_level: { type: "string" },
          requires_diagram: { type: "boolean" },
          diagram_asset: {},
          field_confidence: {
            type: "object",
            additionalProperties: { type: "number" }
          },
          overall_confidence: { type: "number" },
          validation_errors: {
            type: "array",
            items: { type: "string", enum: [...extractionValidationReasonCodes] }
          },
          source_evidence: {}
        }
      }
    }
  }
} as const;

const chatCompletionSchema = z.object({
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

export class MistralOcrProvider {
  constructor(private readonly config: MistralConfig) {}

  async processDocumentUrl(documentUrl: string): Promise<OcrResult> {
    const raw = await callMistral(this.config.apiKey, "/v1/ocr", {
      model: this.config.ocrModel,
      document: {
        type: "document_url",
        document_url: documentUrl
      },
      confidence_scores_granularity: "word",
      table_format: "markdown",
      include_image_base64: false
    });
    const parsed = mistralOcrResponseSchema.parse(raw);
    return {
      provider: "MISTRAL",
      model: parsed.model,
      pages: parsed.pages.map(normalizeMistralPage),
      usage: {
        pagesProcessed: parsed.usage_info?.pages_processed,
        docSizeBytes: parsed.usage_info?.doc_size_bytes
      },
      rawJson: raw
    };
  }
}

export class MistralQuestionExtractor {
  constructor(private readonly config: MistralConfig) {}

  async extractFromPages(pages: OcrPage[]): Promise<QuestionExtractionResult> {
    const raw = await callMistral(this.config.apiKey, "/v1/chat/completions", {
      model: this.config.extractorModel,
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "question_candidates",
          strict: true,
          schema: extractionResponseJsonSchema
        }
      },
      messages: [
        {
          role: "system",
          content:
            "Extract question candidates from OCR markdown. Return only JSON matching the provided schema. Use the exact snake_case field names from the schema. field_confidence must be an object keyed by field name with numeric confidence values, not a single number. Include chapter, topic, subtopic, validation_errors, source_evidence, answer_source_type, answer_source_backed, and whether diagrams are required. validation_errors must use only the enum codes from the schema; use VALIDATION_FAILED for non-canonical extraction problems. Use answer_source_type=SOURCE_KEY only when the answer is directly present in the OCR source; otherwise use LLM_GENERATED and do not hide uncertainty."
        },
        {
          role: "user",
          content: buildExtractionPrompt(pages)
        }
      ]
    });
    const completion = chatCompletionSchema.parse(raw);
    const firstChoice = completion.choices[0];
    if (!firstChoice) {
      throw new Error("Mistral extraction returned no choices");
    }
    return {
      provider: "mistral",
      model: this.config.extractorModel,
      candidates: parseMistralExtractionContent(firstChoice.message.content),
      rawJson: raw,
      usage: {
        promptTokens: completion.usage?.prompt_tokens,
        completionTokens: completion.usage?.completion_tokens,
        totalTokens: completion.usage?.total_tokens
      }
    };
  }
}

export function parseMistralExtractionContent(content: string): ExtractedQuestionCandidate[] {
  const extracted = parseExtractionResponse(content);
  return extracted.candidates.map((candidate) => ({
    questionNumber: candidate.question_number,
    sectionName: candidate.section_name,
    pageNumber: candidate.page_number,
    sourcePageStart: candidate.source_page_start,
    sourcePageEnd: candidate.source_page_end,
    rawOcrText: candidate.raw_ocr_text,
    cleanedQuestionText: candidate.cleaned_question_text,
    questionType: candidate.question_type,
    marks: candidate.marks,
    options: candidate.options,
    answerText: candidate.answer_text,
    solutionText: candidate.solution_text,
    answerSourceType: candidate.answer_source_type,
    answerSourceBacked: candidate.answer_source_backed,
    chapter: candidate.chapter,
    topic: candidate.topic,
    subtopic: candidate.subtopic,
    difficulty: candidate.difficulty,
    bloomLevel: candidate.bloom_level,
    requiresDiagram: candidate.requires_diagram,
    diagramAsset: candidate.diagram_asset,
    fieldConfidence: candidate.field_confidence,
    overallConfidence: candidate.overall_confidence,
    validationErrors: normalizeValidationErrors(candidate.validation_errors),
    sourceEvidence: candidate.source_evidence
  }));
}

function parseExtractionResponse(content: string) {
  try {
    return extractionResponseSchema.parse(JSON.parse(content));
  } catch (error) {
    throw new Error("Mistral extraction response did not match the required candidate schema.", {
      cause: error
    });
  }
}

function normalizeMistralPage(page: z.infer<typeof mistralOcrPageSchema>): OcrPage {
  const confidence = page.confidence_scores ?? undefined;
  return {
    pageNumber: page.index + 1,
    markdown: page.markdown,
    plainText: page.markdown,
    averageConfidence: confidence?.average_page_confidence_score,
    minimumConfidence: confidence?.minimum_page_confidence_score,
    width: page.dimensions?.width,
    height: page.dimensions?.height,
    dpi: page.dimensions?.dpi,
    rawJson: page,
    blocks: [
      {
        blockType: "markdown_page",
        text: page.markdown,
        confidence: confidence?.average_page_confidence_score,
        rawJson: page
      }
    ]
  };
}

function buildExtractionPrompt(pages: OcrPage[]) {
  return pages
    .map((page) => {
      return `Page ${page.pageNumber}\\nOCR confidence: avg=${page.averageConfidence ?? "unknown"} min=${
        page.minimumConfidence ?? "unknown"
      }\\n\\n${page.markdown}`;
    })
    .join("\\n\\n---\\n\\n");
}

async function callMistral(apiKey: string, path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`https://api.mistral.ai${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Mistral request failed ${response.status}: ${errorBody}`);
  }

  return response.json();
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string) {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function normalizeValidationErrors(reasons: string[]) {
  return [...new Set(reasons.map((reason) => (isKnownReviewReason(reason) ? reason : "VALIDATION_FAILED")))];
}

function isKnownReviewReason(reason: string): reason is (typeof extractionValidationReasonCodes)[number] {
  return extractionValidationReasonCodes.some((knownReason) => knownReason === reason);
}
