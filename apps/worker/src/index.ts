import "@queans/db/load-env";

import { NativeConnection, Worker } from "@temporalio/worker";

import { loadWorkerConfig } from "./config.js";
import * as appActivities from "./activities/app.activities.js";
import * as llmActivities from "./activities/llm.activities.js";
import * as ocrActivities from "./activities/ocr.activities.js";
import { resolveWorkflowEntryPath } from "./workflow-entry.js";

const config = loadWorkerConfig();
const connection = await NativeConnection.connect({ address: config.TEMPORAL_ADDRESS });

const workflowWorker = await Worker.create({
  connection,
  namespace: config.TEMPORAL_NAMESPACE,
  taskQueue: config.TEMPORAL_TASK_QUEUE_PAPER_INGESTION,
  workflowsPath: resolveWorkflowEntryPath(import.meta.url),
  activities: appActivities
});

const ocrWorker = await Worker.create({
  connection,
  namespace: config.TEMPORAL_NAMESPACE,
  taskQueue: config.TEMPORAL_TASK_QUEUE_OCR,
  activities: ocrActivities
});

const llmWorker = await Worker.create({
  connection,
  namespace: config.TEMPORAL_NAMESPACE,
  taskQueue: config.TEMPORAL_TASK_QUEUE_LLM,
  activities: llmActivities
});

await Promise.all([workflowWorker.run(), ocrWorker.run(), llmWorker.run()]);
