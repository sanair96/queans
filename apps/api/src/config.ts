import { z } from "zod";

const configSchema = z.object({
  NODE_ENV: z.string().default("development"),
  API_PORT: z.coerce.number().int().positive().default(4000),
  APP_URL: z.string().url().default("http://localhost:3000"),
  TEMPORAL_ADDRESS: z.string().min(1).default("localhost:7233"),
  TEMPORAL_NAMESPACE: z.string().min(1).default("default"),
  TEMPORAL_TASK_QUEUE_PAPER_INGESTION: z.string().min(1).default("paper-ingestion"),
  TEMPORAL_TASK_QUEUE_OCR: z.string().min(1).default("paper-ocr"),
  TEMPORAL_TASK_QUEUE_LLM: z.string().min(1).default("paper-llm-extraction")
});

export function loadConfig() {
  return configSchema.parse(process.env);
}

export type ApiConfig = ReturnType<typeof loadConfig>;
