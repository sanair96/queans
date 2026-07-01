import { z } from "zod";

const workerConfigSchema = z.object({
  TEMPORAL_ADDRESS: z.string().min(1).default("localhost:7233"),
  TEMPORAL_NAMESPACE: z.string().min(1).default("default"),
  TEMPORAL_TASK_QUEUE_PAPER_INGESTION: z.string().min(1).default("paper-ingestion"),
  TEMPORAL_TASK_QUEUE_OCR: z.string().min(1).default("paper-ocr"),
  TEMPORAL_TASK_QUEUE_LLM: z.string().min(1).default("paper-llm-extraction")
});

export function loadWorkerConfig() {
  return workerConfigSchema.parse(process.env);
}

export type WorkerConfig = ReturnType<typeof loadWorkerConfig>;

