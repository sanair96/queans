import { z } from "zod";

import {
  BlueprintExtractionResponseError,
  blueprintExtractionJsonSchema,
  blueprintExtractionSystemPrompt,
  parseBlueprintExtractionResult
} from "./blueprint-extraction-contract.js";
import type {
  BlueprintExtractionResult,
  BlueprintLanguageAnalysisResult,
  ExtractedQuestionCandidate,
  OcrImage,
  OcrPage,
  OcrResult,
  QuestionExtractionResult,
  QuestionSolvingResult
} from "./types.js";

export interface MistralConfig {
  apiKey: string;
  ocrModel: string;
  extractorModel: string;
  segmentationModel: string;
  solverModel: string;
  requestTimeoutMs?: number | undefined;
}

export function loadMistralConfigFromEnv(env: NodeJS.ProcessEnv): MistralConfig {
  const extractorModel = env.EXTRACTOR_MODEL?.trim() || "mistral-small-latest";
  return {
    apiKey: requiredEnv(env, "MISTRAL_API_KEY"),
    ocrModel: env.MISTRAL_OCR_MODEL?.trim() || "mistral-ocr-latest",
    extractorModel,
    segmentationModel: env.MISTRAL_SEGMENTATION_MODEL?.trim() || extractorModel,
    solverModel: env.MISTRAL_SOLVER_MODEL?.trim() || "mistral-large-latest",
    requestTimeoutMs: optionalPositiveIntegerEnv(env, "MISTRAL_REQUEST_TIMEOUT_MS")
  };
}

export const mistralBatchEndpoints = ["/v1/ocr", "/v1/chat/completions"] as const;

export type MistralBatchEndpoint = (typeof mistralBatchEndpoints)[number];

export interface MistralBatchLine {
  custom_id: string;
  body: unknown;
}

export interface MistralBatchJob {
  id: string;
  status: string;
  model?: string | undefined;
  endpoint?: string | undefined;
  inputFiles: string[];
  outputFile?: string | undefined;
  errorFile?: string | undefined;
  totalRequests?: number | undefined;
  succeededRequests?: number | undefined;
  failedRequests?: number | undefined;
  rawJson: unknown;
}

export interface MistralBatchResultLine {
  id?: string | undefined;
  customId: string;
  statusCode?: number | undefined;
  body?: unknown;
  error?: unknown;
  rawJson: unknown;
}

const mistralOcrPageSchema = z.object({
  index: z.number(),
  markdown: z.string(),
  images: z.array(z.unknown()).nullable().optional(),
  blocks: z.array(z.unknown()).nullable().optional(),
  tables: z.array(z.unknown()).nullable().optional(),
  dimensions: z
    .object({
      dpi: z.number().optional(),
      height: z.number().optional(),
      width: z.number().optional()
    })
    .nullable()
    .optional(),
  confidence_scores: z
    .object({
      average_page_confidence_score: z.number().optional(),
      minimum_page_confidence_score: z.number().optional()
    })
    .nullable()
    .optional()
});

const mistralBatchUploadSchema = z.object({
  id: z.string()
});

const mistralBatchJobSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    model: z.string().optional(),
    endpoint: z.string().optional(),
    input_files: z.array(z.string()).optional(),
    inputFiles: z.array(z.string()).optional(),
    output_file: z.string().nullable().optional(),
    outputFile: z.string().nullable().optional(),
    error_file: z.string().nullable().optional(),
    errorFile: z.string().nullable().optional(),
    total_requests: z.number().optional(),
    totalRequests: z.number().optional(),
    succeeded_requests: z.number().optional(),
    succeededRequests: z.number().optional(),
    failed_requests: z.number().optional(),
    failedRequests: z.number().optional()
  })
  .passthrough();

const mistralBatchResultLineSchema = z
  .object({
    id: z.string().optional(),
    custom_id: z.string(),
    response: z
      .object({
        status_code: z.number().optional(),
        body: z.unknown().optional()
      })
      .nullable()
      .optional(),
    error: z.unknown().nullable().optional()
  })
  .passthrough();

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
  parent_question_number: z.string().optional(),
  question_label: z.string().optional(),
  part_label: z.string().optional(),
  group_key: z.string().optional(),
  stem_text: z.string().optional(),
  display_order: z.number().int().optional(),
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

const solvingResponseSchema = z.object({
  candidate: extractionCandidateSchema
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
          parent_question_number: { type: "string" },
          question_label: { type: "string" },
          part_label: { type: "string" },
          group_key: { type: "string" },
          stem_text: { type: "string" },
          display_order: { type: "integer" },
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
            additionalProperties: { type: "number", minimum: 0, maximum: 1 }
          },
          overall_confidence: { type: "number", minimum: 0, maximum: 1 },
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

const questionSegmentationJsonSchema = extractionResponseJsonSchema;

const questionSolvingJsonSchema = {
  title: "SolvedQuestionCandidate",
  type: "object",
  additionalProperties: false,
  required: ["candidate"],
  properties: {
    candidate: extractionResponseJsonSchema.properties.candidates.items
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

const blueprintLanguageAnalysisResponseSchema = z.object({
  detected_languages: z.array(
    z.object({
      tag: z.string().min(1),
      display_name: z.string().min(1).optional(),
      confidence: z.number().min(0).max(1).nullable().optional(),
      page_numbers: z.array(z.number().int().positive()).optional()
    })
  ).min(1),
  primary_language: z.object({
    tag: z.string().min(1).nullable(),
    confidence: z.number().min(0).max(1).nullable()
  }),
  mixed_language_page_numbers: z.array(z.number().int().positive()),
  multilingual_relationship: z.enum([
    "MONOLINGUAL",
    "DUPLICATE_TRANSLATIONS",
    "DISTINCT_REQUIREMENTS",
    "MIXED_OR_UNCERTAIN"
  ]),
  page_languages: z.array(
    z.object({
      page_number: z.number().int().positive(),
      languages: z.array(
        z.object({
          tag: z.string().min(1),
          display_name: z.string().min(1).optional(),
          confidence: z.number().min(0).max(1).nullable().optional()
        })
      ).min(1)
    })
  )
});

const blueprintLanguageAnalysisJsonSchema = {
  title: "BlueprintLanguageAnalysis",
  type: "object",
  additionalProperties: false,
  required: [
    "detected_languages",
    "primary_language",
    "mixed_language_page_numbers",
    "multilingual_relationship",
    "page_languages"
  ],
  properties: {
    detected_languages: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["tag"],
        properties: {
          tag: { type: "string" },
          display_name: { type: "string" },
          confidence: { type: ["number", "null"], minimum: 0, maximum: 1 },
          page_numbers: { type: "array", items: { type: "integer", minimum: 1 } }
        }
      }
    },
    primary_language: {
      type: "object",
      additionalProperties: false,
      required: ["tag", "confidence"],
      properties: {
        tag: { type: ["string", "null"] },
        confidence: { type: ["number", "null"], minimum: 0, maximum: 1 }
      }
    },
    mixed_language_page_numbers: { type: "array", items: { type: "integer", minimum: 1 } },
    multilingual_relationship: {
      type: "string",
      enum: ["MONOLINGUAL", "DUPLICATE_TRANSLATIONS", "DISTINCT_REQUIREMENTS", "MIXED_OR_UNCERTAIN"]
    },
    page_languages: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["page_number", "languages"],
        properties: {
          page_number: { type: "integer", minimum: 1 },
          languages: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["tag"],
              properties: {
                tag: { type: "string" },
                display_name: { type: "string" },
                confidence: { type: ["number", "null"], minimum: 0, maximum: 1 }
              }
            }
          }
        }
      }
    }
  }
} as const;

const defaultMistralRequestTimeoutMs = 120_000;

const blueprintLanguageAnalysisSystemPrompt = [
  "Analyze OCR pages from one uploaded blueprint document. Do not extract rules or rewrite the document.",
  "Identify every language present using valid BCP 47 tags, including mixed-language pages.",
  "Classify multilingual content as MONOLINGUAL, DUPLICATE_TRANSLATIONS when blocks express the same rules, DISTINCT_REQUIREMENTS when language blocks contain additional requirements, or MIXED_OR_UNCERTAIN when evidence is insufficient.",
  "Page language evidence must preserve every detected language; never treat a bilingual document as separate documents.",
  "Choose a primary language only from detected languages. If uncertain, set tag to null and confidence to null.",
  "Return only the requested JSON."
].join(" ");

const segmentationSystemPrompt = [
  "Segment OCR markdown into question candidates only. Do not answer or solve.",
  "Return JSON matching the schema and use the exact snake_case field names.",
  "Create one candidate for each answerable question or answerable sub-question.",
  "Do not create a separate parent-only candidate when the parent only introduces subparts.",
  "For subquestions, repeat the shared stem_text, set parent_question_number to the visible parent number, set part_label to the visible subpart label, use one stable group_key for every part in the parent group, and keep cleaned_question_text self-contained.",
  "Preserve section_name, visible question_number, question_label, source pages, and paper order with display_order.",
  "Infer per-part marks from explicit part marks or nearby allocation text such as '(2+3=5)', '(5 x 1 = 5 marks)', or '(2+3+2+3=10)'.",
  "Include every visible MCQ option and diagram/image reference that the question depends on."
].join(" ");

const extractionSystemPrompt = [
  "Extract question candidates from OCR markdown. Return only JSON matching the provided schema.",
  "Use the exact snake_case field names from the schema.",
  "Create one candidate per answerable item, including one candidate per answerable subquestion.",
  "Do not create a separate parent-only candidate when the parent only introduces subparts.",
  "Preserve section_name, visible question_number, question_label, source pages, and paper order with display_order.",
  "For subquestions, set one stable group_key shared by every part, parent_question_number, part_label, question_label, stem_text, and display_order.",
  "cleaned_question_text must be self-contained enough to solve without the rest of the paper, while stem_text carries the shared case/diagram/introduction.",
  "Infer per-part marks from explicit candidate marks or section allocation text such as '(2+3=5)', '(5 x 1 = 5 marks)', and '(2+3+2+3=10)'.",
  "field_confidence must be an object keyed by canonical field names like question_text, question_type, marks, answer_text, topic, difficulty, options, and diagram_asset; do not use schema/meta field names like validation_errors or overall_confidence as confidence keys.",
  "Include chapter, topic, subtopic, validation_errors, source_evidence, answer_source_type, answer_source_backed, and whether diagrams are required.",
  "If a diagram/image is needed, set requires_diagram=true and diagram_asset to the exact image asset metadata from the prompt.",
  "validation_errors must use only the enum codes from the schema; use VALIDATION_FAILED for non-canonical extraction problems.",
  "Use answer_source_type=SOURCE_KEY only when an answer or answer key is directly present in the OCR source; otherwise use LLM_GENERATED."
].join(" ");

const solvingSystemPrompt = [
  "Repair incomplete OCR-grounded questions only when the source evidence supports the repair, then solve.",
  "Preserve section_name, question_number, parent_question_number, question_label, part_label, group_key, stem_text, display_order, marks, options, and diagram_asset from the candidate unless the evidence clearly improves them.",
  "Keep each subquestion as its own candidate; never merge sibling parts into one answer.",
  "Always fill answer_text and solution_text for answerable questions that can be solved from the OCR text, attached images, or standard subject knowledge.",
  "For numerical questions, compute the answer from the visible values, include units, and explain the formula in solution_text.",
  "For MCQs, preserve or reconstruct the visible options and set answer_text to the correct option text or option label plus text.",
  "Use answer_source_type=SOURCE_KEY only when an answer or answer key is directly present in the OCR source; otherwise use LLM_GENERATED.",
  "Do not add ANSWER_UNCERTAIN or LLM_GENERATED_ANSWER_UNVERIFIED when answer_text is complete and field_confidence.answer_text is at least 0.9.",
  "If the question, answer, marks, options, or diagram is too incomplete or uncertain after solving, keep the uncertainty explicit with validation_errors.",
  "Return JSON matching the schema."
].join(" ");

export class MistralOcrProvider {
  constructor(private readonly config: MistralConfig) {}

  async processDocumentUrl(documentUrl: string): Promise<OcrResult> {
    const raw = await callMistral(
      this.config,
      "/v1/ocr",
      {
        model: this.config.ocrModel,
        document: {
          type: "document_url",
          document_url: documentUrl
        },
        confidence_scores_granularity: "word",
        table_format: "markdown",
        include_image_base64: true
      }
    );
    return parseMistralOcrResult(raw);
  }
}

export class MistralBlueprintLanguageAnalyzer {
  constructor(private readonly config: MistralConfig) {}

  async analyzePages(input: { pages: Array<{ pageNumber: number; markdown: string }> }): Promise<BlueprintLanguageAnalysisResult> {
    const raw = await callMistral(this.config, "/v1/chat/completions", {
      model: this.config.extractorModel,
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "blueprint_language_analysis",
          strict: true,
          schema: blueprintLanguageAnalysisJsonSchema
        }
      },
      messages: [
        { role: "system", content: blueprintLanguageAnalysisSystemPrompt },
        {
          role: "user",
          content: input.pages.map((page) => `Page ${page.pageNumber}:\n${page.markdown}`).join("\n\n")
        }
      ]
    });
    const completion = chatCompletionSchema.parse(raw);
    const firstChoice = completion.choices[0];
    if (!firstChoice) {
      throw new Error("Mistral Blueprint language analysis returned no choices");
    }
    const analysis = blueprintLanguageAnalysisResponseSchema.parse(JSON.parse(firstChoice.message.content) as unknown);

    return {
      provider: "mistral",
      model: this.config.extractorModel,
      detectedLanguages: analysis.detected_languages.map((language) => ({
        tag: language.tag,
        displayName: language.display_name,
        confidence: language.confidence,
        pageNumbers: language.page_numbers
      })),
      primaryLanguage: {
        tag: analysis.primary_language.tag,
        confidence: analysis.primary_language.confidence
      },
      mixedLanguagePageNumbers: analysis.mixed_language_page_numbers,
      multilingualRelationship: analysis.multilingual_relationship,
      pageLanguages: analysis.page_languages.map((page) => ({
        pageNumber: page.page_number,
        languages: page.languages.map((language) => ({
          tag: language.tag,
          displayName: language.display_name,
          confidence: language.confidence
        }))
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

export class MistralBlueprintRuleExtractor {
  constructor(private readonly config: MistralConfig) {}

  async extractRules(input: {
    primaryLanguage: string;
    pages: Array<{ pageNumber: number; markdown: string }>;
  }): Promise<BlueprintExtractionResult> {
    const raw = await callMistral(this.config, "/v1/chat/completions", {
      model: this.config.extractorModel,
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "blueprint_extraction",
          strict: true,
          schema: blueprintExtractionJsonSchema
        }
      },
      messages: [
        { role: "system", content: blueprintExtractionSystemPrompt },
        {
          role: "user",
          content: [
            `Designated primary language: ${input.primaryLanguage}`,
            "OCR pages:",
            ...input.pages.map((page) => `Page ${page.pageNumber}:\n${page.markdown}`)
          ].join("\n\n")
        }
      ]
    });

    try {
      return parseBlueprintExtractionResult(raw, this.config.extractorModel, "mistral");
    } catch (error) {
      throw new BlueprintExtractionResponseError(
        error instanceof Error ? error.message : "Blueprint extraction response was invalid.",
        raw
      );
    }
  }
}

export class MistralBatchProvider {
  constructor(private readonly config: MistralConfig) {}

  buildOcrBatchLine(input: { customId: string; documentUrl: string }): MistralBatchLine {
    return {
      custom_id: input.customId,
      body: {
        confidence_scores_granularity: "word",
        table_format: "markdown",
        include_image_base64: true,
        document: {
          type: "document_url",
          document_url: input.documentUrl
        }
      }
    };
  }

  buildSegmentationBatchLine(input: { customId: string; pages: OcrPage[] }): MistralBatchLine {
    return {
      custom_id: input.customId,
      body: {
        temperature: 0,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "question_segments",
            strict: true,
            schema: questionSegmentationJsonSchema
          }
        },
        messages: [
          {
            role: "system",
            content: segmentationSystemPrompt
          },
          {
            role: "user",
            content: buildExtractionPrompt(input.pages)
          }
        ]
      }
    };
  }

  buildSolvingBatchLine(input: {
    customId: string;
    candidate: ExtractedQuestionCandidate;
    imageUrls: Array<{ url: string; label: string }>;
  }): MistralBatchLine {
    const content: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: string }> = [
      {
        type: "text",
        text: buildSolvingPrompt(input.candidate, input.imageUrls)
      },
      ...input.imageUrls.map((image) => ({
        type: "image_url" as const,
        image_url: image.url
      }))
    ];

    return {
      custom_id: input.customId,
      body: {
        temperature: 0,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "solved_question_candidate",
            strict: true,
            schema: questionSolvingJsonSchema
          }
        },
        messages: [
          {
            role: "system",
            content: solvingSystemPrompt
          },
          {
            role: "user",
            content
          }
        ]
      }
    };
  }

  async uploadBatchJsonl(input: { fileName: string; lines: MistralBatchLine[] }) {
    const form = new FormData();
    form.append("purpose", "batch");
    form.append("file", new Blob([toJsonl(input.lines)], { type: "application/jsonl" }), input.fileName);
    const raw = await callMistralForm(this.config, "/v1/files", form);
    return mistralBatchUploadSchema.parse(raw).id;
  }

  async createBatchJob(input: {
    inputFileId: string;
    endpoint: MistralBatchEndpoint;
    model: string;
    metadata?: Record<string, string> | undefined;
  }) {
    const raw = await callMistral(this.config, "/v1/batch/jobs", {
      input_files: [input.inputFileId],
      endpoint: input.endpoint,
      model: input.model,
      metadata: input.metadata
    });
    return normalizeMistralBatchJob(raw);
  }

  async retrieveBatchJob(providerJobId: string) {
    const raw = await getMistral(this.config, `/v1/batch/jobs/${providerJobId}`);
    return normalizeMistralBatchJob(raw);
  }

  async downloadBatchResultFile(fileId: string) {
    const content = await getMistralText(this.config, `/v1/files/${fileId}/content`);
    return parseBatchResultJsonl(content);
  }
}

export class MistralQuestionExtractor {
  constructor(private readonly config: MistralConfig) {}

  async extractFromPages(pages: OcrPage[]): Promise<QuestionExtractionResult> {
    const raw = await callMistral(this.config, "/v1/chat/completions", {
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
          content: extractionSystemPrompt
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

  async solveCandidate(
    candidate: ExtractedQuestionCandidate,
    imageUrls: Array<{ url: string; label: string }>
  ): Promise<QuestionSolvingResult> {
    const raw = await callMistral(this.config, "/v1/chat/completions", {
      model: this.config.solverModel,
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "solved_question_candidate",
          strict: true,
          schema: questionSolvingJsonSchema
        }
      },
      messages: [
        {
          role: "system",
          content: solvingSystemPrompt
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: buildSolvingPrompt(candidate, imageUrls)
            },
            ...imageUrls.map((image) => ({
              type: "image_url" as const,
              image_url: image.url
            }))
          ]
        }
      ]
    });
    const completion = chatCompletionSchema.parse(raw);
    const firstChoice = completion.choices[0];
    if (!firstChoice) {
      throw new Error("Mistral solving returned no choices");
    }

    return {
      provider: "mistral",
      model: this.config.solverModel,
      candidate: parseMistralSolvingContent(firstChoice.message.content),
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
  return extracted.candidates.map(normalizeExtractionCandidate);
}

export function parseMistralSolvingContent(content: string): ExtractedQuestionCandidate {
  const solved = parseSolvingResponse(content);
  return normalizeExtractionCandidate(solved.candidate);
}

export function parseMistralOcrResult(raw: unknown): OcrResult {
  const parsed = mistralOcrResponseSchema.parse(raw);
  return {
    provider: "MISTRAL",
    model: parsed.model,
    pages: parsed.pages.map(normalizeMistralPage),
    usage: {
      pagesProcessed: parsed.usage_info?.pages_processed,
      docSizeBytes: parsed.usage_info?.doc_size_bytes
    },
    rawJson: sanitizeMistralOcrRawJson(raw)
  };
}

function normalizeExtractionCandidate(candidate: z.infer<typeof extractionCandidateSchema>): ExtractedQuestionCandidate {
  const invalidConfidence =
    isOutOfRangeConfidence(candidate.overall_confidence) ||
    Object.values(candidate.field_confidence).some(isOutOfRangeConfidence);
  const diagramAsset = normalizeDiagramAssetForQuestion(candidate.cleaned_question_text, candidate.diagram_asset);
  const requiresDiagram = candidate.requires_diagram && (diagramAsset !== undefined || referencesProvidedDiagram(candidate.cleaned_question_text));
  const grouping = normalizeGroupingFields(candidate);
  const questionType = normalizeQuestionTypeLabel(candidate.question_type);
  const options = normalizeQuestionOptions(candidate.options) ?? candidate.options;
  const validationErrors = normalizeValidationErrors([
    ...candidate.validation_errors.filter((reason) => reason !== "DIAGRAM_ASSET_MISSING" || requiresDiagram),
    ...requiredFieldValidationErrors({ ...candidate, options }, questionType, requiresDiagram, diagramAsset),
    ...(invalidConfidence ? ["VALIDATION_FAILED"] : [])
  ]);

  return {
    questionNumber: grouping.questionNumber,
    sectionName: nonEmptyOptional(candidate.section_name),
    pageNumber: candidate.page_number,
    sourcePageStart: candidate.source_page_start,
    sourcePageEnd: candidate.source_page_end,
    rawOcrText: candidate.raw_ocr_text,
    cleanedQuestionText: candidate.cleaned_question_text,
    parentQuestionNumber: grouping.parentQuestionNumber,
    questionLabel: grouping.questionLabel,
    partLabel: grouping.partLabel,
    groupKey: grouping.groupKey,
    stemText: grouping.stemText,
    displayOrder: candidate.display_order,
    questionType,
    marks: candidate.marks,
    options,
    answerText: candidate.answer_text,
    solutionText: candidate.solution_text,
    answerSourceType: candidate.answer_source_type,
    answerSourceBacked: candidate.answer_source_backed,
    chapter: nonEmptyOptional(candidate.chapter),
    topic: nonEmptyOptional(candidate.topic),
    subtopic: nonEmptyOptional(candidate.subtopic),
    difficulty: nonEmptyOptional(candidate.difficulty),
    bloomLevel: nonEmptyOptional(candidate.bloom_level),
    requiresDiagram,
    diagramAsset,
    fieldConfidence: normalizeFieldConfidence(candidate.field_confidence),
    overallConfidence: normalizeConfidence(candidate.overall_confidence),
    validationErrors,
    sourceEvidence: candidate.source_evidence
  };
}

function normalizeGroupingFields(candidate: z.infer<typeof extractionCandidateSchema>) {
  const questionNumber = nonEmptyOptional(candidate.question_number);
  const parentQuestionNumber = nonEmptyOptional(candidate.parent_question_number);
  const partLabel = nonEmptyOptional(candidate.part_label);
  const stemText = nonEmptyOptional(candidate.stem_text);
  const questionLabel =
    nonEmptyOptional(candidate.question_label) ?? (parentQuestionNumber ? `Question ${parentQuestionNumber}` : undefined);
  const groupKey =
    nonEmptyOptional(candidate.group_key) ??
    (parentQuestionNumber && (partLabel || stemText)
      ? [candidate.section_name, parentQuestionNumber]
          .map((part) => part?.trim().toLowerCase().replace(/\s+/g, "-"))
          .filter(Boolean)
          .join(":")
      : undefined);

  return {
    questionNumber,
    parentQuestionNumber,
    questionLabel,
    partLabel,
    groupKey,
    stemText
  };
}

function normalizeQuestionTypeLabel(questionType: string) {
  return questionType.trim().toUpperCase().replace(/[\s-]+/g, "_");
}

function requiredFieldValidationErrors(
  candidate: z.infer<typeof extractionCandidateSchema>,
  questionType: string,
  requiresDiagram: boolean,
  diagramAsset: unknown
) {
  const errors: string[] = [];
  if (candidate.cleaned_question_text.trim().length === 0) {
    errors.push("MISSING_QUESTION_TEXT");
  }
  if (candidate.marks === undefined) {
    errors.push("MISSING_MARKS");
  }
  if (questionType === "MCQ" && !hasMcqOptions(candidate.options)) {
    errors.push("MCQ_OPTIONS_MISSING");
  }
  if (!candidate.answer_text?.trim()) {
    errors.push("ANSWER_UNCERTAIN");
  }
  if (requiresDiagram && diagramAsset === undefined) {
    errors.push("DIAGRAM_ASSET_MISSING");
  }
  return errors;
}

function hasMcqOptions(value: unknown) {
  return (normalizeQuestionOptions(value)?.length ?? 0) >= 2;
}

function normalizeQuestionOptions(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const options = value.flatMap((item) => normalizeOptionItem(item));
    return options.length >= 2 ? options : undefined;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const options = record.options ?? record.choices;
  const normalizedNestedOptions = normalizeQuestionOptions(options);
  if (normalizedNestedOptions) {
    return normalizedNestedOptions;
  }

  const keyedOptions = Object.entries(record).flatMap(([label, item]) => normalizeOptionItem(item, label));
  return keyedOptions.length >= 2 ? keyedOptions : undefined;
}

function normalizeOptionItem(value: unknown, fallbackLabel?: string): string[] {
  if (typeof value === "string") {
    const text = value.trim();
    return text.length > 0 ? [formatOptionText(fallbackLabel, text)] : [];
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  const record = value as Record<string, unknown>;
  const text = stringOptionValue(record.text) ?? stringOptionValue(record.value) ?? stringOptionValue(record.label);
  if (!text) {
    return [];
  }
  return [formatOptionText(stringOptionValue(record.label) ?? stringOptionValue(record.code) ?? fallbackLabel, text)];
}

function stringOptionValue(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function formatOptionText(label: string | undefined, text: string) {
  const normalizedLabel = label?.trim().replace(/^\((.*)\)$/u, "$1");
  if (!normalizedLabel || normalizedLabel === text) {
    return text;
  }
  return `(${normalizedLabel}) ${text}`;
}

function nonEmptyOptional(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function normalizeDiagramAsset(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    const assets = value.map(normalizeDiagramAsset).filter((asset) => asset !== undefined);
    return assets.length > 0 ? assets : undefined;
  }

  const record = Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== null && item !== undefined && item !== "")
  );
  return Object.keys(record).length > 0 ? record : undefined;
}

function normalizeDiagramAssetForQuestion(questionText: string, value: unknown) {
  const asset = normalizeDiagramAsset(value);
  if (asset === undefined) {
    return undefined;
  }
  return referencesProvidedDiagram(questionText) ? asset : undefined;
}

function referencesProvidedDiagram(questionText: string) {
  return /\b(as shown|shown below|shown above|shown in|given below|given above|given (circuit|figure|diagram|image)|figure shows|diagram shows|image shows|observe (the )?(figure|diagram|image|circuit)|based on (the )?(figure|diagram|image|circuit)|from (the )?(figure|diagram|image|circuit)|in the (figure|diagram|image)|the following (figure|diagram|image)|following (figure|diagram|image)|circuit shown)\b/iu.test(
    questionText
  );
}

export function parseMistralChatCandidateBatchBody(body: unknown) {
  const completion = chatCompletionSchema.parse(body);
  const firstChoice = completion.choices[0];
  if (!firstChoice) {
    throw new Error("Mistral batch chat response returned no choices");
  }

  return {
    content: firstChoice.message.content,
    usage: {
      promptTokens: completion.usage?.prompt_tokens,
      completionTokens: completion.usage?.completion_tokens,
      totalTokens: completion.usage?.total_tokens
    }
  };
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

function parseSolvingResponse(content: string) {
  try {
    return solvingResponseSchema.parse(JSON.parse(content));
  } catch (error) {
    throw new Error("Mistral solving response did not match the required candidate schema.", {
      cause: error
    });
  }
}

function normalizeMistralPage(page: z.infer<typeof mistralOcrPageSchema>): OcrPage {
  const confidence = page.confidence_scores ?? undefined;
  const images = normalizeMistralImages(page);
  const imageBlocks = images.map((image) => ({
    blockType: "image",
    text: image.fileName,
    boundingBox: image.boundingBox,
    sourceAsset: {
      id: image.id,
      fileName: image.fileName,
      mimeType: image.mimeType
    },
    rawJson: sanitizeMistralOcrRawJson(image.rawJson)
  }));
  const providerBlocks = (page.blocks ?? []).map((block) => normalizeMistralBlock(block));
  return {
    pageNumber: page.index + 1,
    markdown: page.markdown,
    plainText: page.markdown,
    averageConfidence: confidence?.average_page_confidence_score,
    minimumConfidence: confidence?.minimum_page_confidence_score,
    width: page.dimensions?.width,
    height: page.dimensions?.height,
    dpi: page.dimensions?.dpi,
    rawJson: sanitizeMistralOcrRawJson(page),
    blocks: [
      {
        blockType: "markdown_page",
        text: page.markdown,
        confidence: confidence?.average_page_confidence_score,
        rawJson: sanitizeMistralOcrRawJson(page)
      },
      ...providerBlocks,
      ...imageBlocks
    ],
    images
  };
}

function buildExtractionPrompt(pages: OcrPage[]) {
  return pages
    .map((page) => {
      const imageAssets = page.blocks
        .filter((block) => block.blockType === "image")
        .map((block, index) => `- image ${index + 1}: ${JSON.stringify(block.sourceAsset ?? { label: block.text })}`)
        .join("\n");
      return `Page ${page.pageNumber}\\nOCR confidence: avg=${page.averageConfidence ?? "unknown"} min=${
        page.minimumConfidence ?? "unknown"
      }\\nImage assets on this page:\\n${imageAssets || "- none"}\\nAttach diagram_asset only when the question refers to a provided source figure/image/diagram on the paper, such as "as shown", "given below", "observe the figure", or a circuit/figure shown in the paper. Do not attach a source image to questions that ask the student to draw/sketch a diagram when no source diagram is provided.\\n\\n${page.markdown}`;
    })
    .join("\\n\\n---\\n\\n");
}

function buildSolvingPrompt(candidate: ExtractedQuestionCandidate, imageUrls: Array<{ label: string; url: string }>) {
  const diagramLines =
    imageUrls.length > 0
      ? imageUrls.map((image, index) => `${index + 1}. ${image.label}: ${image.url}`).join("\\n")
      : "No diagram images were attached.";

  return [
    "OCR-grounded candidate:",
    JSON.stringify(candidate, null, 2),
    "",
    "Attached image URLs:",
    diagramLines,
    "",
    "Return the same candidate shape. Fix incomplete OCR text only when the evidence supports the fix. Solve only this candidate."
  ].join("\\n");
}

function normalizeMistralImages(page: z.infer<typeof mistralOcrPageSchema>): OcrImage[] {
  return (page.images ?? []).flatMap((image, index) => {
    const imageRecord = asRecordOrUndefined(image);
    const imageBase64 = stringRecordValue(imageRecord, "image_base64") ?? stringRecordValue(imageRecord, "base64");
    if (!imageBase64) {
      return [];
    }

    const parsed = parseImageBase64(imageBase64);
    const id = stringRecordValue(imageRecord, "id") ?? `page-${page.index + 1}-image-${index + 1}`;
    return [
      {
        id,
        fileName: imageFileName(id, parsed.mimeType),
        mimeType: parsed.mimeType,
        base64: parsed.base64,
        boundingBox: boundingBoxFromRecord(imageRecord),
        rawJson: sanitizeMistralOcrRawJson(image)
      }
    ];
  });
}

function normalizeMistralBlock(block: unknown) {
  const blockRecord = asRecordOrUndefined(block);
  const blockType = stringRecordValue(blockRecord, "type") ?? stringRecordValue(blockRecord, "block_type") ?? "ocr_block";
  const text = stringRecordValue(blockRecord, "text") ?? stringRecordValue(blockRecord, "content") ?? "";
  return {
    blockType,
    text,
    boundingBox: boundingBoxFromRecord(blockRecord),
    sourceAsset: blockRecord?.image_id ? { imageId: blockRecord.image_id } : undefined,
    rawJson: sanitizeMistralOcrRawJson(block)
  };
}

function parseImageBase64(value: string) {
  const match = /^data:(?<mimeType>[-\w.]+\/[-+\w.]+);base64,(?<base64>.*)$/u.exec(value);
  if (match?.groups?.mimeType && match.groups.base64) {
    return {
      mimeType: match.groups.mimeType,
      base64: match.groups.base64
    };
  }

  return {
    mimeType: "image/png",
    base64: value
  };
}

function imageFileName(id: string, mimeType: string) {
  const extension = mimeType.split("/")[1]?.replace(/[^a-zA-Z0-9]/g, "") || "png";
  return `${id.replace(/[^a-zA-Z0-9._-]/g, "_")}.${extension}`;
}

function boundingBoxFromRecord(record: Record<string, unknown> | undefined) {
  if (!record) {
    return undefined;
  }

  const keys = ["bbox", "bounding_box", "top_left_x", "top_left_y", "bottom_right_x", "bottom_right_y"];
  const entries = keys
    .filter((key) => Object.prototype.hasOwnProperty.call(record, key))
    .map((key) => [key, record[key]] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function sanitizeMistralOcrRawJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeMistralOcrRawJson);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, childValue]) => [
      key,
      key === "image_base64" || key === "base64" ? "[stored-in-r2]" : sanitizeMistralOcrRawJson(childValue)
    ])
  );
}

function normalizeMistralBatchJob(raw: unknown): MistralBatchJob {
  const parsed = mistralBatchJobSchema.parse(raw);
  return {
    id: parsed.id,
    status: parsed.status,
    model: parsed.model,
    endpoint: parsed.endpoint,
    inputFiles: parsed.input_files ?? parsed.inputFiles ?? [],
    outputFile: parsed.output_file ?? parsed.outputFile ?? undefined,
    errorFile: parsed.error_file ?? parsed.errorFile ?? undefined,
    totalRequests: parsed.total_requests ?? parsed.totalRequests,
    succeededRequests: parsed.succeeded_requests ?? parsed.succeededRequests,
    failedRequests: parsed.failed_requests ?? parsed.failedRequests,
    rawJson: raw
  };
}

function parseBatchResultJsonl(content: string): MistralBatchResultLine[] {
  return content
    .split("\\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const raw = JSON.parse(line) as unknown;
      const parsed = mistralBatchResultLineSchema.parse(raw);
      return {
        id: parsed.id,
        customId: parsed.custom_id,
        statusCode: parsed.response?.status_code,
        body: parsed.response?.body,
        error: parsed.error ?? undefined,
        rawJson: raw
      };
    });
}

function toJsonl(lines: MistralBatchLine[]) {
  return lines.map((line) => JSON.stringify(line)).join("\\n");
}

async function callMistral(config: MistralConfig, path: string, body: unknown): Promise<unknown> {
  const response = await fetchWithTimeout(config, path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
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

async function callMistralForm(config: MistralConfig, path: string, body: FormData): Promise<unknown> {
  const response = await fetchWithTimeout(config, path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`
    },
    body
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Mistral request failed ${response.status}: ${errorBody}`);
  }

  return response.json();
}

async function getMistral(config: MistralConfig, path: string): Promise<unknown> {
  const response = await fetchWithTimeout(config, path, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${config.apiKey}`
    }
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Mistral request failed ${response.status}: ${errorBody}`);
  }

  return response.json();
}

async function getMistralText(config: MistralConfig, path: string) {
  const response = await fetchWithTimeout(config, path, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${config.apiKey}`
    }
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Mistral request failed ${response.status}: ${errorBody}`);
  }

  return response.text();
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string) {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalPositiveIntegerEnv(env: NodeJS.ProcessEnv, key: string) {
  const raw = env[key]?.trim();
  if (!raw) {
    return undefined;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${key} must be a positive integer when set.`);
  }
  return parsed;
}

async function fetchWithTimeout(config: MistralConfig, path: string, init: RequestInit) {
  const timeoutMs = config.requestTimeoutMs ?? defaultMistralRequestTimeoutMs;
  try {
    return await fetch(`https://api.mistral.ai${path}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(`Mistral request timed out after ${timeoutMs}ms: ${path}`);
    }
    throw error;
  }
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "TimeoutError";
}

function normalizeValidationErrors(reasons: string[]) {
  return [...new Set(reasons.map((reason) => (isKnownReviewReason(reason) ? reason : "VALIDATION_FAILED")))];
}

function isKnownReviewReason(reason: string): reason is (typeof extractionValidationReasonCodes)[number] {
  return extractionValidationReasonCodes.some((knownReason) => knownReason === reason);
}

function normalizeFieldConfidence(confidence: Record<string, number>) {
  return Object.fromEntries(Object.entries(confidence).map(([fieldName, value]) => [fieldName, normalizeConfidence(value)]));
}

function normalizeConfidence(value: number) {
  return isOutOfRangeConfidence(value) ? 0 : value;
}

function isOutOfRangeConfidence(value: number) {
  return value < 0 || value > 1;
}

function asRecordOrUndefined(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function stringRecordValue(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}
