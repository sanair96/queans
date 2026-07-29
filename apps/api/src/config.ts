import { z } from "zod";

import { defaultMistralExecutionMode, mistralExecutionModes } from "@queans/core";

const configSchema = z.object({
  NODE_ENV: z.string().default("development"),
  API_PORT: z.coerce.number().int().positive().default(4000),
  APP_URL: z.string().url().default("http://localhost:3000"),
  INTERNAL_API_TOKEN: z.string().trim().min(1),
  MISTRAL_EXECUTION_MODE: z.enum(mistralExecutionModes).default(defaultMistralExecutionMode),
  TEMPORAL_ADDRESS: z.string().min(1).default("localhost:7233"),
  TEMPORAL_NAMESPACE: z.string().min(1).default("default"),
  TEMPORAL_TASK_QUEUE_PAPER_INGESTION: z.string().min(1).default("paper-ingestion"),
  TEMPORAL_TASK_QUEUE_BLUEPRINT_INGESTION: z.string().min(1).default("blueprint-ingestion"),
  TEMPORAL_TASK_QUEUE_OCR: z.string().min(1).default("paper-ocr"),
  TEMPORAL_TASK_QUEUE_LLM: z.string().min(1).default("paper-llm-extraction")
});

export function loadConfig() {
  return configSchema.parse(process.env);
}

export type ApiConfig = ReturnType<typeof loadConfig>;
