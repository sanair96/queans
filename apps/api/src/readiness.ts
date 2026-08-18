import { prisma } from "@queans/db";
import { loadMistralConfigFromEnv, loadQuestionExtractorProviderFromEnv, loadR2ConfigFromEnv } from "@queans/providers";

import type { ApiConfig } from "./config.js";
import { getTemporalClient } from "./temporal.js";

export interface ReadinessCheckResult {
  ok: boolean;
  error?: string;
}

export interface ReadinessResult {
  ok: boolean;
  checks: {
    database: ReadinessCheckResult;
    temporal: ReadinessCheckResult;
    r2: ReadinessCheckResult;
    mistral: ReadinessCheckResult;
  };
}

export interface ReadinessDependencies {
  checkDatabase?: () => void | Promise<void>;
  checkTemporal?: () => void | Promise<void>;
  checkR2Config?: () => void | Promise<void>;
  checkMistralConfig?: () => void | Promise<void>;
}

export async function checkReadiness(
  config: ApiConfig,
  dependencies: ReadinessDependencies = {}
): Promise<ReadinessResult> {
  const [database, temporal, r2, mistral] = await Promise.all([
    runReadinessCheck(dependencies.checkDatabase ?? checkDatabaseReady),
    runReadinessCheck(dependencies.checkTemporal ?? (() => checkTemporalReady(config))),
    runReadinessCheck(dependencies.checkR2Config ?? checkR2ConfigReady),
    runReadinessCheck(dependencies.checkMistralConfig ?? checkMistralConfigReady)
  ]);

  return {
    ok: database.ok && temporal.ok && r2.ok && mistral.ok,
    checks: {
      database,
      temporal,
      r2,
      mistral
    }
  };
}

export async function checkDatabaseReady() {
  await prisma.$queryRaw`SELECT 1`;
  const schemaObjects = await prisma.$queryRaw<{ table_name: string; column_name: string }[]>`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND (
        (table_name = 'workflow_runs' AND column_name IN ('retry_of_workflow_run_id', 'blueprint_document_id'))
        OR (table_name = 'provider_batch_jobs' AND column_name = 'id')
        OR (table_name = 'blueprint_documents' AND column_name IN ('draft_rules_json', 'review_version'))
        OR (table_name = 'blueprint_ocr_pages' AND column_name = 'blueprint_document_id')
        OR (table_name = 'blueprint_ocr_blocks' AND column_name = 'blueprint_ocr_page_id')
        OR (table_name = 'blueprint_ocr_assets' AND column_name = 'blueprint_ocr_page_id')
      )
  `;
  const availableSchemaObjects = new Set(schemaObjects.map((schemaObject) => `${schemaObject.table_name}.${schemaObject.column_name}`));
  const missingSchemaObjects = requiredDatabaseSchemaObjects.filter((schemaObject) => !availableSchemaObjects.has(schemaObject));
  if (missingSchemaObjects.length > 0) {
    throw new Error(`Database schema is not migrated. Missing: ${missingSchemaObjects.join(", ")}. Run pnpm db:deploy.`);
  }
}

export async function checkTemporalReady(config: ApiConfig) {
  const client = await getTemporalClient(config);
  await withTimeout(client.workflowService.getSystemInfo({}), 2000, "Temporal readiness check timed out");
}

export function checkR2ConfigReady() {
  loadR2ConfigFromEnv(process.env);
}

export function checkMistralConfigReady() {
  loadQuestionExtractorProviderFromEnv(process.env);
  loadMistralConfigFromEnv(process.env);
}

async function runReadinessCheck(check: () => void | Promise<void>): Promise<ReadinessCheckResult> {
  try {
    await check();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown readiness check failure"
    };
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

const requiredDatabaseSchemaObjects = [
  "workflow_runs.retry_of_workflow_run_id",
  "workflow_runs.blueprint_document_id",
  "provider_batch_jobs.id",
  "blueprint_documents.draft_rules_json",
  "blueprint_documents.review_version",
  "blueprint_ocr_pages.blueprint_document_id",
  "blueprint_ocr_blocks.blueprint_ocr_page_id",
  "blueprint_ocr_assets.blueprint_ocr_page_id"
] as const;
