export interface OcrBlock {
  blockType: string;
  text: string;
  confidence?: number | undefined;
  boundingBox?: unknown;
  sourceAsset?: unknown;
  rawJson?: unknown;
}

export interface OcrImage {
  id: string;
  fileName: string;
  mimeType: string;
  base64: string;
  boundingBox?: unknown;
  rawJson?: unknown;
}

export interface OcrPage {
  pageNumber: number;
  markdown: string;
  plainText?: string | undefined;
  averageConfidence?: number | undefined;
  minimumConfidence?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
  dpi?: number | undefined;
  rawJson: unknown;
  blocks: OcrBlock[];
  images: OcrImage[];
}

export interface OcrResult {
  provider: "MISTRAL" | "GOOGLE_DOCUMENT_AI";
  model: string;
  pages: OcrPage[];
  usage: {
    pagesProcessed?: number | undefined;
    docSizeBytes?: number | undefined;
  };
  rawJson: unknown;
}

/** Durable OCR layout context supplied with a Blueprint page. Image pixels are deliberately excluded. */
export interface BlueprintOcrLayoutBlock {
  blockType: string;
  text: string;
  confidence?: number | null | undefined;
  boundingBox?: unknown;
  sourceAsset?: unknown;
}

/** Durable metadata for an OCR image or diagram asset referenced by a Blueprint page. */
export interface BlueprintOcrAssetContext {
  sourceAssetId: string;
  fileName: string;
  mimeType: string;
  boundingBox?: unknown;
  metadata?: unknown;
}

export interface BlueprintStructuredOcrPage {
  pageNumber: number;
  markdown: string;
  plainText?: string | null | undefined;
  averageConfidence?: number | null | undefined;
  minimumConfidence?: number | null | undefined;
  width?: number | null | undefined;
  height?: number | null | undefined;
  dpi?: number | null | undefined;
  blocks?: BlueprintOcrLayoutBlock[] | undefined;
  assets?: BlueprintOcrAssetContext[] | undefined;
}

export interface BlueprintLanguageEvidenceResult {
  tag: string;
  displayName?: string | undefined;
  confidence?: number | null | undefined;
  pageNumbers?: number[] | undefined;
}

export interface BlueprintLanguageAnalysisResult {
  provider: "mistral";
  model: string;
  detectedLanguages: BlueprintLanguageEvidenceResult[];
  primaryLanguage: {
    tag: string | null;
    confidence: number | null;
  };
  mixedLanguagePageNumbers: number[];
  multilingualRelationship: "MONOLINGUAL" | "DUPLICATE_TRANSLATIONS" | "DISTINCT_REQUIREMENTS" | "MIXED_OR_UNCERTAIN";
  pageLanguages: Array<{
    pageNumber: number;
    languages: BlueprintLanguageEvidenceResult[];
  }>;
  documentAnalysis: {
    isMarkingScheme: boolean;
    confidence: number | null;
    titleLanguageTag: string | null;
    headerLanguageTag: string | null;
    evidencePageNumbers: number[];
    evaluatorInstructionPageNumbers: number[];
    markingSchemePageNumbers: number[];
    paperCode: string | null;
  };
  rawJson: unknown;
  usage: {
    promptTokens?: number | undefined;
    completionTokens?: number | undefined;
    totalTokens?: number | undefined;
  };
}

export interface BlueprintSourceReferenceResult {
  pageNumber: number;
  languageTag?: string | undefined;
  snippet?: string | undefined;
  startOffset?: number | undefined;
  endOffset?: number | undefined;
  confidence?: number | null | undefined;
}

export interface BlueprintExtractionAuditConflict {
  questionNumber: string;
  field: "marks" | "section";
  values: Array<string | number>;
  sourcePages: number[];
}

export interface BlueprintUnparseableQuestionRange {
  sectionName: string;
  questionRange: string;
  sourcePages: number[];
}

export interface BlueprintMarkReconciliation {
  status: "MATCH" | "MISMATCH" | "UNAVAILABLE";
  declaredTotalMarks: number | null;
  extractedTotalMarks: number | null;
  choiceAdjustedSections: string[];
}

export interface BlueprintExtractionAudit {
  reconciled: boolean;
  expectedQuestionNumbers: string[];
  extractedQuestionNumbers: string[];
  missingQuestionNumbers: string[];
  duplicateQuestionNumbers: string[];
  conflicts: BlueprintExtractionAuditConflict[];
  markReconciliation: BlueprintMarkReconciliation;
  unparseableRanges: BlueprintUnparseableQuestionRange[];
}

export interface BlueprintExtractionRecovery {
  attempted: boolean;
  requestedQuestionNumbers: string[];
  pageNumbers: number[];
  recoveredQuestionNumbers: string[];
}

export interface BlueprintExtractionResult {
  provider: "mistral";
  model: string;
  rules: unknown;
  confidence: number | null;
  sourceReferences: BlueprintSourceReferenceResult[];
  warnings: string[];
  rawJson: unknown;
  audit?: BlueprintExtractionAudit | undefined;
  recovery?: BlueprintExtractionRecovery | undefined;
  usage: {
    promptTokens?: number | undefined;
    completionTokens?: number | undefined;
    totalTokens?: number | undefined;
  };
}

export interface ExtractedQuestionCandidate {
  questionNumber?: string | undefined;
  sectionName?: string | undefined;
  pageNumber?: number | undefined;
  sourcePageStart?: number | undefined;
  sourcePageEnd?: number | undefined;
  rawOcrText: string;
  cleanedQuestionText: string;
  parentQuestionNumber?: string | undefined;
  questionLabel?: string | undefined;
  partLabel?: string | undefined;
  groupKey?: string | undefined;
  stemText?: string | undefined;
  displayOrder?: number | undefined;
  questionType: string;
  marks?: number | undefined;
  options?: unknown;
  answerText?: string | undefined;
  solutionText?: string | undefined;
  answerSourceType: "SOURCE_KEY" | "LLM_GENERATED";
  answerSourceBacked: boolean;
  chapter?: string | undefined;
  topic?: string | undefined;
  subtopic?: string | undefined;
  difficulty?: string | undefined;
  bloomLevel?: string | undefined;
  requiresDiagram: boolean;
  diagramAsset?: unknown;
  fieldConfidence: Record<string, number>;
  overallConfidence: number;
  validationErrors: string[];
  sourceEvidence: unknown;
}

export interface QuestionExtractionResult {
  provider: "mistral";
  model: string;
  candidates: ExtractedQuestionCandidate[];
  rawJson: unknown;
  usage: {
    promptTokens?: number | undefined;
    completionTokens?: number | undefined;
    totalTokens?: number | undefined;
  };
}

export interface QuestionSolvingResult {
  provider: "mistral";
  model: string;
  candidate: ExtractedQuestionCandidate;
  rawJson: unknown;
  usage: {
    promptTokens?: number | undefined;
    completionTokens?: number | undefined;
    totalTokens?: number | undefined;
  };
}
