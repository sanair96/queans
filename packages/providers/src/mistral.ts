import { z } from "zod";

import type { OcrPage, OcrResult, QuestionExtractionResult } from "./types.js";

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
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Extract question candidates from OCR markdown. Return only JSON matching {\"candidates\": [...]}. Include field_confidence, validation_errors, source_evidence, and whether diagrams are required. Do not hide uncertainty."
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
    const extracted = extractionResponseSchema.parse(JSON.parse(firstChoice.message.content));
    return {
      provider: "mistral",
      model: this.config.extractorModel,
      candidates: extracted.candidates.map((candidate) => ({
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
        chapter: candidate.chapter,
        topic: candidate.topic,
        subtopic: candidate.subtopic,
        difficulty: candidate.difficulty,
        bloomLevel: candidate.bloom_level,
        requiresDiagram: candidate.requires_diagram,
        diagramAsset: candidate.diagram_asset,
        fieldConfidence: candidate.field_confidence,
        overallConfidence: candidate.overall_confidence,
        validationErrors: candidate.validation_errors.filter(isKnownReviewReason),
        sourceEvidence: candidate.source_evidence
      })),
      rawJson: raw,
      usage: {
        promptTokens: completion.usage?.prompt_tokens,
        completionTokens: completion.usage?.completion_tokens,
        totalTokens: completion.usage?.total_tokens
      }
    };
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

function isKnownReviewReason(reason: string): reason is QuestionExtractionResult["candidates"][number]["validationErrors"][number] {
  return [
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
  ].includes(reason);
}

