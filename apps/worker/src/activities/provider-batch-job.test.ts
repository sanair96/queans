import { describe, expect, it } from "vitest";

import { ProviderBatchJobStatus } from "@queans/db";

import { assertBatchSucceeded, mapMistralBatchStatus, providerBatchJobCreateData } from "./provider-batch-job.js";

describe("mapMistralBatchStatus", () => {
  it("maps provider lifecycle names to local operator statuses", () => {
    expect(mapMistralBatchStatus("queued")).toBe(ProviderBatchJobStatus.SUBMITTED);
    expect(mapMistralBatchStatus("running")).toBe(ProviderBatchJobStatus.RUNNING);
    expect(mapMistralBatchStatus("success")).toBe(ProviderBatchJobStatus.SUCCEEDED);
    expect(mapMistralBatchStatus("failed")).toBe(ProviderBatchJobStatus.FAILED);
    expect(mapMistralBatchStatus("cancelled")).toBe(ProviderBatchJobStatus.CANCELLED);
  });
});

describe("assertBatchSucceeded", () => {
  it("requires a successful provider job with an output file before import", () => {
    expect(() =>
      assertBatchSucceeded({
        id: "batch-1",
        status: "SUCCESS",
        inputFiles: ["file-in"],
        outputFile: "file-out",
        rawJson: {}
      })
    ).not.toThrow();

    expect(() =>
      assertBatchSucceeded({
        id: "batch-1",
        status: "SUCCESS",
        inputFiles: ["file-in"],
        rawJson: {}
      })
    ).toThrow("succeeded without an output file");
  });
});

describe("providerBatchJobCreateData", () => {
  it("records provider file ids, status, and retry lineage", () => {
    expect(
      providerBatchJobCreateData({
        workflowRunId: "run-1",
        sourcePaperId: "source-1",
        operation: "question_solving",
        endpoint: "/v1/chat/completions",
        model: "mistral-large-latest",
        inputFileId: "file-in",
        retryOfBatchJobId: "batch-old",
        batchJob: {
          id: "batch-new",
          status: "RUNNING",
          inputFiles: ["file-in"],
          totalRequests: 3,
          rawJson: { id: "batch-new" }
        }
      })
    ).toMatchObject({
      workflowRunId: "run-1",
      sourcePaperId: "source-1",
      retryOfBatchJobId: "batch-old",
      provider: "MISTRAL",
      operation: "question_solving",
      endpoint: "/v1/chat/completions",
      model: "mistral-large-latest",
      status: ProviderBatchJobStatus.RUNNING,
      inputFileId: "file-in",
      providerJobId: "batch-new",
      totalRequests: 3
    });
  });
});
