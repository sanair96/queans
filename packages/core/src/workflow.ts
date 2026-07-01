export const PAPER_INGESTION_TASK_QUEUE = "paper-ingestion";
export const PAPER_OCR_TASK_QUEUE = "paper-ocr";
export const PAPER_LLM_TASK_QUEUE = "paper-llm-extraction";

export const PAPER_INGESTION_WORKFLOW_TYPE = "PaperIngestionWorkflow";

export function paperIngestionWorkflowId(ingestionRunId: string) {
  return `paper-ingestion/${ingestionRunId}`;
}

export const paperIngestionSteps = [
  "store_file",
  "run_ocr",
  "parse_ocr_layout",
  "segment_questions",
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
  taskQueues?: {
    ocr: string;
    llm: string;
  };
}

export interface HumanReviewCompletedSignal {
  workflowRunId: string;
  reviewedBy?: string;
}
