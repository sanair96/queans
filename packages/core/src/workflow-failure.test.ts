import { describe, expect, it } from "vitest";

import { serializeWorkflowFailure, summarizeWorkflowFailure } from "./workflow-failure.js";

describe("serializeWorkflowFailure", () => {
  it("preserves Error name and message", () => {
    const error = new TypeError("OCR provider timed out");

    expect(serializeWorkflowFailure(error)).toMatchObject({
      name: "TypeError",
      message: "OCR provider timed out"
    });
  });

  it("serializes string failures", () => {
    expect(serializeWorkflowFailure("worker cancelled")).toEqual({
      message: "worker cancelled"
    });
  });

  it("serializes non-error values without leaking object internals", () => {
    expect(serializeWorkflowFailure({ reason: "bad payload" })).toEqual({
      message: "Workflow failed with a non-error value"
    });
  });

  it("preserves nested error causes", () => {
    const error = new Error("Activity task failed", {
      cause: new Error("Missing required environment variable: R2_ACCOUNT_ID")
    });

    expect(serializeWorkflowFailure(error)).toMatchObject({
      message: "Activity task failed",
      cause: {
        message: "Missing required environment variable: R2_ACCOUNT_ID"
      }
    });
  });
});

describe("summarizeWorkflowFailure", () => {
  it("summarizes nested Zod extraction failures into operator-facing details", () => {
    const summary = summarizeWorkflowFailure(
      {
        name: "ActivityFailure",
        message: "Activity failed",
        cause: {
          name: "ApplicationFailure",
          message: "ZodError",
          stack: `ZodError: [
  {
    "code": "invalid_type",
    "expected": "string",
    "received": "undefined",
    "path": [
      "candidates",
      0,
      "raw_ocr_text"
    ],
    "message": "Required"
  },
  {
    "code": "invalid_type",
    "expected": "string",
    "received": "undefined",
    "path": [
      "candidates",
      0,
      "cleaned_question_text"
    ],
    "message": "Required"
  },
  {
    "code": "invalid_type",
    "expected": "object",
    "received": "undefined",
    "path": [
      "candidates",
      1,
      "field_confidence"
    ],
    "message": "Required"
  }
]
    at get error (/repo/node_modules/zod/lib/index.js:43:31)`
        }
      },
      { failedStep: "extract_question_candidates" }
    );

    expect(summary).toMatchObject({
      title: "Question extraction returned malformed candidates",
      detail: "Question extraction returned malformed candidates: 2 candidates are missing required fields.",
      failedStep: "extract_question_candidates",
      failureType: "ApplicationFailure",
      rootCause: "ZodError"
    });
    expect(summary.issues).toEqual([
      {
        path: ["candidates", 0, "raw_ocr_text"],
        field: "raw_ocr_text",
        message: "Required",
        code: "invalid_type",
        expected: "string",
        received: "undefined",
        candidateIndex: 0
      },
      {
        path: ["candidates", 0, "cleaned_question_text"],
        field: "cleaned_question_text",
        message: "Required",
        code: "invalid_type",
        expected: "string",
        received: "undefined",
        candidateIndex: 0
      },
      {
        path: ["candidates", 1, "field_confidence"],
        field: "field_confidence",
        message: "Required",
        code: "invalid_type",
        expected: "object",
        received: "undefined",
        candidateIndex: 1
      }
    ]);
  });

  it("keeps raw messages when there are no structured validation issues", () => {
    expect(summarizeWorkflowFailure({ name: "Error", message: "No OCR pages found" })).toMatchObject({
      title: "Workflow failed",
      detail: "No OCR pages found",
      failureType: "Error",
      rootCause: "No OCR pages found",
      issues: []
    });
  });

  it("ignores malformed Zod stack snippets", () => {
    expect(
      summarizeWorkflowFailure({
        name: "ApplicationFailure",
        message: "ZodError",
        stack: "ZodError: [{ not valid json"
      })
    ).toMatchObject({
      title: "Workflow failed",
      detail: "ZodError",
      rootCause: "ZodError",
      issues: []
    });
  });
});
