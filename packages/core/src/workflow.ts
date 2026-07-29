export const PAPER_INGESTION_TASK_QUEUE = "paper-ingestion";
export const PAPER_OCR_TASK_QUEUE = "paper-ocr";
export const PAPER_LLM_TASK_QUEUE = "paper-llm-extraction";
export const BLUEPRINT_INGESTION_TASK_QUEUE = "blueprint-ingestion";

export const PAPER_INGESTION_WORKFLOW_TYPE = "PaperIngestionWorkflow";
export const BLUEPRINT_INGESTION_WORKFLOW_TYPE = "BlueprintIngestionWorkflow";

export const mistralExecutionModes = ["sync", "batch"] as const;
export type MistralExecutionMode = (typeof mistralExecutionModes)[number];
export const defaultMistralExecutionMode = "sync" satisfies MistralExecutionMode;

export function paperIngestionWorkflowId(ingestionRunId: string) {
  return `paper-ingestion/${ingestionRunId}`;
}

export const paperIngestionSteps = [
  "store_file",
  "submit_ocr_batch",
  "import_ocr_batch",
  "parse_ocr_layout",
  "submit_segmentation_batch",
  "import_segmentation_batch",
  "submit_solving_batch",
  "import_solving_batch",
  "segment_questions",
  "run_ocr",
  "extract_question_candidates",
  "enrich_with_topics_and_answers",
  "validate_candidates",
  "create_review_tasks",
  "wait_for_review",
  "apply_human_corrections",
  "commit_to_question_bank",
  "create_embeddings",
  "dedupe_check",
  "complete"
] as const;

export type PaperIngestionStep = (typeof paperIngestionSteps)[number];

export interface PaperIngestionWorkflowInput {
  ingestionRunId: string;
  sourcePaperId: string;
  executionMode?: MistralExecutionMode | undefined;
  retryImportBatchJobId?: string | undefined;
  retryImportOperation?: "ocr" | "question_segmentation" | "question_solving" | undefined;
  taskQueues?: {
    ocr: string;
    llm: string;
  };
}

export interface HumanReviewCompletedSignal {
  workflowRunId: string;
  reviewedBy?: string;
}

export function blueprintIngestionWorkflowId(workflowRunId: string) {
  return `blueprint-ingestion/${workflowRunId}`;
}

export interface BlueprintIngestionWorkflowInput {
  workflowRunId: string;
  blueprintDocumentId: string;
  mode: BlueprintIngestionMode;
}

export const blueprintIngestionModes = ["FULL", "RESUME_FROM_OCR"] as const;
export type BlueprintIngestionMode = (typeof blueprintIngestionModes)[number];
