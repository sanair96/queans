import { describe, expect, it } from "vitest";

import { checkReadiness } from "./readiness.js";
import type { ApiConfig } from "./config.js";

const apiConfig: ApiConfig = {
  NODE_ENV: "test",
  API_PORT: 4000,
  APP_URL: "http://localhost:3000",
  INTERNAL_API_TOKEN: "test-internal-token",
  TEMPORAL_ADDRESS: "localhost:7233",
  TEMPORAL_NAMESPACE: "default",
  TEMPORAL_TASK_QUEUE_PAPER_INGESTION: "paper-ingestion",
  TEMPORAL_TASK_QUEUE_OCR: "paper-ocr",
  TEMPORAL_TASK_QUEUE_LLM: "paper-llm-extraction"
};

describe("checkReadiness", () => {
  it("reports ready when database and Temporal checks pass", async () => {
    await expect(
      checkReadiness(apiConfig, {
        checkDatabase: () => Promise.resolve(),
        checkTemporal: () => Promise.resolve()
      })
    ).resolves.toEqual({
      ok: true,
      checks: {
        database: { ok: true },
        temporal: { ok: true }
      }
    });
  });

  it("reports per-dependency failures", async () => {
    await expect(
      checkReadiness(apiConfig, {
        checkDatabase: () => Promise.reject(new Error("database unavailable")),
        checkTemporal: () => Promise.resolve()
      })
    ).resolves.toEqual({
      ok: false,
      checks: {
        database: {
          ok: false,
          error: "database unavailable"
        },
        temporal: { ok: true }
      }
    });
  });
});
