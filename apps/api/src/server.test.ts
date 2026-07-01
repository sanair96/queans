import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildServer } from "./server.js";
import type { ApiConfig } from "./config.js";

const apiConfig: ApiConfig = {
  NODE_ENV: "test",
  API_PORT: 4000,
  APP_URL: "http://localhost:3000",
  TEMPORAL_ADDRESS: "localhost:7233",
  TEMPORAL_NAMESPACE: "default",
  TEMPORAL_TASK_QUEUE_PAPER_INGESTION: "paper-ingestion",
  TEMPORAL_TASK_QUEUE_OCR: "paper-ocr",
  TEMPORAL_TASK_QUEUE_LLM: "paper-llm-extraction"
};

const r2EnvKeys = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET"
] as const;

const originalR2Env = new Map<string, string | undefined>();

describe("buildServer", () => {
  beforeEach(() => {
    for (const key of r2EnvKeys) {
      originalR2Env.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of r2EnvKeys) {
      const value = originalR2Env.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    originalR2Env.clear();
  });

  it("serves health checks without R2 credentials", async () => {
    const app = await buildServer(apiConfig);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/health"
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });

  it("returns a clear upload configuration error when R2 credentials are missing", async () => {
    const app = await buildServer(apiConfig);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/uploads/init",
        payload: {
          fileName: "paper.pdf",
          mimeType: "application/pdf",
          byteSize: 1024
        }
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        error: "R2_CONFIGURATION_ERROR",
        message: "Missing required environment variable: R2_ACCOUNT_ID"
      });
    } finally {
      await app.close();
    }
  });
});
