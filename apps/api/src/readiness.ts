import { prisma } from "@queans/db";

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
  };
}

export interface ReadinessDependencies {
  checkDatabase?: () => Promise<void>;
  checkTemporal?: () => Promise<void>;
}

export async function checkReadiness(
  config: ApiConfig,
  dependencies: ReadinessDependencies = {}
): Promise<ReadinessResult> {
  const [database, temporal] = await Promise.all([
    runReadinessCheck(dependencies.checkDatabase ?? checkDatabaseReady),
    runReadinessCheck(dependencies.checkTemporal ?? (() => checkTemporalReady(config)))
  ]);

  return {
    ok: database.ok && temporal.ok,
    checks: {
      database,
      temporal
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

async function runReadinessCheck(check: () => Promise<void>): Promise<ReadinessCheckResult> {
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
