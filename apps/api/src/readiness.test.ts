import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn()
}));

vi.mock("@queans/db", () => ({
  prisma: {
    $queryRaw: mocks.queryRaw
  }
}));

import { checkDatabaseReady, checkMistralConfigReady, checkReadiness } from "./readiness.js";
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

afterEach(() => {
  vi.unstubAllEnvs();
  mocks.queryRaw.mockReset();
});

describe("checkReadiness", () => {
  it("reports ready when database and Temporal checks pass", async () => {
    await expect(
      checkReadiness(apiConfig, {
        checkDatabase: () => Promise.resolve(),
        checkTemporal: () => Promise.resolve(),
        checkR2Config: () => Promise.resolve(),
        checkMistralConfig: () => Promise.resolve()
      })
    ).resolves.toEqual({
      ok: true,
      checks: {
        database: { ok: true },
        temporal: { ok: true },
        r2: { ok: true },
        mistral: { ok: true }
      }
    });
  });

  it("reports per-dependency failures", async () => {
    await expect(
      checkReadiness(apiConfig, {
        checkDatabase: () => Promise.reject(new Error("database unavailable")),
        checkTemporal: () => Promise.resolve(),
        checkR2Config: () => Promise.reject(new Error("Missing required environment variable: R2_BUCKET")),
        checkMistralConfig: () => Promise.reject(new Error("Missing required environment variable: MISTRAL_API_KEY"))
      })
    ).resolves.toEqual({
      ok: false,
      checks: {
        database: {
          ok: false,
          error: "database unavailable"
        },
        temporal: { ok: true },
        r2: {
          ok: false,
          error: "Missing required environment variable: R2_BUCKET"
        },
        mistral: {
          ok: false,
          error: "Missing required environment variable: MISTRAL_API_KEY"
        }
      }
    });
  });
});

describe("checkDatabaseReady", () => {
  it("accepts the migrated schema required by upload completion", async () => {
    mocks.queryRaw
      .mockResolvedValueOnce([{ connected: 1 }])
      .mockResolvedValueOnce([
        { table_name: "provider_batch_jobs", column_name: "id" },
        { table_name: "workflow_runs", column_name: "retry_of_workflow_run_id" }
      ]);

    await expect(checkDatabaseReady()).resolves.toBeUndefined();
  });

  it("reports the exact missing migration object before uploads can fail", async () => {
    mocks.queryRaw
      .mockResolvedValueOnce([{ connected: 1 }])
      .mockResolvedValueOnce([{ table_name: "provider_batch_jobs", column_name: "id" }]);

    await expect(checkDatabaseReady()).rejects.toThrow(
      "Database schema is not migrated. Missing: workflow_runs.retry_of_workflow_run_id. Run pnpm db:deploy."
    );
  });
});

describe("checkMistralConfigReady", () => {
  it("rejects unsupported extractor providers before runtime ingestion starts", () => {
    vi.stubEnv("LLM_PROVIDER", "openai");
    vi.stubEnv("MISTRAL_API_KEY", "test-key");

    expect(() => checkMistralConfigReady()).toThrow("Unsupported LLM_PROVIDER: openai. Supported providers: mistral");
  });

  it("accepts the supported Mistral extractor provider", () => {
    vi.stubEnv("LLM_PROVIDER", "mistral");
    vi.stubEnv("MISTRAL_API_KEY", "test-key");

    expect(() => checkMistralConfigReady()).not.toThrow();
  });
});
