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

export interface ExtractedQuestionCandidate {
  questionNumber?: string | undefined;
  sectionName?: string | undefined;
  pageNumber?: number | undefined;
  sourcePageStart?: number | undefined;
  sourcePageEnd?: number | undefined;
  rawOcrText: string;
  cleanedQuestionText: string;
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
