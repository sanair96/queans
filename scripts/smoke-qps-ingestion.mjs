#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";

const root = new URL("..", import.meta.url);
const qpsDir = new URL("qps/", root);
const args = new Set(process.argv.slice(2));
const apiUrl = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const pollIntervalMs = numberFromEnv("QUEANS_SMOKE_POLL_INTERVAL_MS", 5_000);
const timeoutMs = numberFromEnv("QUEANS_SMOKE_TIMEOUT_MS", 30 * 60_000);
const filePattern = process.env.QUEANS_SMOKE_FILE_PATTERN ? new RegExp(process.env.QUEANS_SMOKE_FILE_PATTERN, "iu") : undefined;
const resetDb = args.has("--reset-db");
const autoApproveReview = args.has("--auto-approve-review");
const autoResolveBlockedReview = args.has("--auto-resolve-blocked-review");

if (resetDb) {
  run("pnpm", ["--filter", "@queans/db", "exec", "tsx", "src/run-prisma.ts", "migrate", "reset", "--schema", "prisma/schema.prisma", "--force"]);
  run("pnpm", ["db:deploy"]);
}

await assertApiReady();

const files = (await readdir(qpsDir))
  .filter((fileName) => supportedMimeType(fileName) !== undefined)
  .filter((fileName) => !filePattern || filePattern.test(fileName))
  .sort((a, b) => a.localeCompare(b));

if (files.length === 0) {
  throw new Error(`No supported question paper files found in ${qpsDir.pathname}`);
}

const runs = [];
for (const fileName of files) {
  const filePath = join(qpsDir.pathname, fileName);
  const file = await readFile(filePath);
  const fileStat = await stat(filePath);
  const mimeType = supportedMimeType(fileName);
  const checksumSha256 = createHash("sha256").update(file).digest("hex");
  console.log(`Uploading ${fileName}`);

  const upload = await apiPost("/api/uploads/init", {
    fileName,
    mimeType,
    byteSize: fileStat.size,
    checksumSha256
  });

  const putResponse = await fetch(upload.uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": mimeType,
      "Content-Length": String(fileStat.size)
    },
    body: file
  });
  if (!putResponse.ok) {
    throw new Error(`R2 upload failed for ${fileName}: ${putResponse.status} ${await putResponse.text()}`);
  }

  const completed = await apiPost(`/api/uploads/${upload.uploadId}/complete`, {
    byteSize: fileStat.size,
    etag: putResponse.headers.get("etag") ?? undefined,
    paperContext: paperContextFromFileName(fileName)
  });
  runs.push({
    fileName,
    sourcePaperId: completed.sourcePaperId,
    ingestionRunId: completed.ingestionRunId
  });
}

const deadline = Date.now() + timeoutMs;
while (Date.now() < deadline) {
  const statuses = await Promise.all(runs.map((run) => ingestionStatus(run)));
  printStatus(statuses);

  const failed = statuses.filter((status) => status.status === "FAILED" || status.status === "CANCELLED");
  if (failed.length > 0) {
    throw new Error(`Ingestion failed: ${failed.map((status) => `${status.fileName}:${status.status}:${status.currentStep}`).join(", ")}`);
  }

  const waitingForReview = statuses.filter((status) => status.status === "WAITING_FOR_REVIEW");
  if (waitingForReview.length > 0 && autoApproveReview) {
    const reviewResolution = await resolveOpenReviewItems();
    console.log(
      `Auto-approved ${reviewResolution.approved} open review item(s); marked ${reviewResolution.markedUnprocessable} blocker(s) unprocessable; ${reviewResolution.blocked} still blocked.`
    );
  }

  if (statuses.every((status) => status.status === "COMPLETED")) {
    break;
  }

  await sleep(pollIntervalMs);
}

const finalStatuses = await Promise.all(runs.map((run) => ingestionStatus(run)));
const incomplete = finalStatuses.filter((status) => status.status !== "COMPLETED");
const reviewTasks = await apiGet("/api/review/tasks");
const questions = await apiGet("/api/questions");
const ingestedFileNames = new Set(runs.map((run) => run.fileName));
const visibleQuestions = questions.questions.filter((question) => ingestedFileNames.has(question.sourcePaper?.sourceFileName));

console.log(
  JSON.stringify(
    {
      uploadedPapers: runs.length,
      completedRuns: finalStatuses.filter((status) => status.status === "COMPLETED").length,
      openReviewItems: reviewTasks.reviewItems.length,
      visibleQuestions: visibleQuestions.length,
      groupedQuestionParts: visibleQuestions.filter((question) => question.parentQuestionNumber && question.partLabel).length
    },
    null,
    2
  )
);

if (incomplete.length > 0) {
  throw new Error(`Timed out before all ingestions completed: ${incomplete.map((status) => `${status.fileName}:${status.status}`).join(", ")}`);
}
if (reviewTasks.reviewItems.length > 0) {
  throw new Error(
    `Smoke run still has ${reviewTasks.reviewItems.length} open review item(s). Re-run with --auto-approve-review --auto-resolve-blocked-review only for local test data.`
  );
}
if (visibleQuestions.length === 0) {
  throw new Error("Smoke run completed but no approved questions from qps/ are visible through /api/questions.");
}

console.log("qps smoke ingestion passed.");

async function assertApiReady() {
  const ready = await fetch(`${apiUrl}/ready`);
  if (!ready.ok) {
    throw new Error(`API is not ready at ${apiUrl}/ready: ${ready.status} ${await ready.text()}`);
  }
}

async function ingestionStatus(run) {
  const status = await apiGet(`/api/ingestions/${run.ingestionRunId}`);
  return {
    ...run,
    status: status.status,
    currentStep: status.currentStep,
    counts: status.counts,
    outputPayload: status.outputPayload
  };
}

async function resolveOpenReviewItems() {
  const reviewTasks = await apiGet("/api/review/tasks");
  let approved = 0;
  let markedUnprocessable = 0;
  let blocked = 0;
  for (const item of reviewTasks.reviewItems) {
    const response = await fetch(`${apiUrl}/api/review/tasks/${item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        decision: "APPROVE",
        reviewedBy: "qps-smoke-runner"
      })
    });
    if (response.ok) {
      approved += 1;
    } else if (response.status !== 409) {
      throw new Error(`Review approval failed for ${item.id}: ${response.status} ${await response.text()}`);
    } else if (autoResolveBlockedReview) {
      const rejected = await fetch(`${apiUrl}/api/review/tasks/${item.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision: "MARK_UNPROCESSABLE",
          reviewedBy: "qps-smoke-runner"
        })
      });
      if (!rejected.ok && rejected.status !== 409) {
        throw new Error(`Review blocker resolution failed for ${item.id}: ${rejected.status} ${await rejected.text()}`);
      }
      if (rejected.ok) {
        markedUnprocessable += 1;
      } else {
        blocked += 1;
      }
    } else {
      blocked += 1;
    }
  }
  return { approved, markedUnprocessable, blocked };
}

function printStatus(statuses) {
  console.log(statuses.map((status) => `${status.fileName}:${status.status}:${status.currentStep}`).join(" | "));
}

async function apiGet(path) {
  const response = await fetch(`${apiUrl}${path}`);
  if (!response.ok) {
    throw new Error(`GET ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function apiPost(path, body) {
  const response = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`POST ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

function supportedMimeType(fileName) {
  const extension = extname(fileName).toLowerCase();
  const mimeTypes = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".odt": "application/vnd.oasis.opendocument.text"
  };
  return mimeTypes[extension];
}

function paperContextFromFileName(fileName) {
  const normalized = basename(fileName, extname(fileName)).replace(/\s+/g, " ").trim();
  return {
    title: normalized,
    board: /(cbse|icse)/iu.exec(normalized)?.[1]?.toUpperCase(),
    classLevel: /class\s*(\d+)/iu.exec(normalized)?.[1],
    subject: /physics/iu.test(normalized) ? "Physics" : undefined,
    uploadedBy: "qps-smoke-runner",
    metadata: {
      smokeSource: "qps"
    }
  };
}

function numberFromEnv(key, fallback) {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(command, commandArgs) {
  execFileSync(command, commandArgs, {
    cwd: root.pathname,
    stdio: "inherit",
    env: process.env
  });
}
