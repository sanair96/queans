import { prisma } from "@queans/db";
import { loadMistralConfigFromEnv, loadR2ConfigFromEnv } from "@queans/providers";

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
}

export async function checkTemporalReady(config: ApiConfig) {
  const client = await getTemporalClient(config);
  await withTimeout(client.workflowService.getSystemInfo({}), 2000, "Temporal readiness check timed out");
}

export function checkR2ConfigReady() {
  loadR2ConfigFromEnv(process.env);
}

export function checkMistralConfigReady() {
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
