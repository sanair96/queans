import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { FailureDiagnosis, formatEstimatedCostUsd, totalEstimatedCostUsd } from "./run-lookup";

vi.stubGlobal("React", React);

const malformedExtractionPayload = {
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
  }
]
    at get error (/repo/node_modules/zod/lib/index.js:43:31)`
  }
};

const malformedExtractionSummary = {
  title: "Question extraction returned malformed candidates",
  detail: "Question extraction returned malformed candidates: 1 candidate is missing required fields.",
  failedStep: "extract_question_candidates",
  failureType: "ZodError",
  rootCause: "ZodError",
  issues: [
    {
      path: ["candidates", 0, "raw_ocr_text"],
      field: "raw_ocr_text",
      message: "Required",
      code: "invalid_type",
      expected: "string",
      received: "undefined",
      candidateIndex: 0
    }
  ]
};

describe("FailureDiagnosis", () => {
  it("renders an operator-facing extraction failure before technical payload details", () => {
    const html = renderToStaticMarkup(
      <FailureDiagnosis summary={malformedExtractionSummary} payload={malformedExtractionPayload} />
    );

    expect(html).toContain("Question extraction returned malformed candidates");
    expect(html).toContain("Failed at");
    expect(html).toContain("extract_question_candidates");
    expect(html).toContain("OCR completed; extraction response did not match the required candidate schema.");
    expect(html).toContain("Candidate 1");
    expect(html).toContain("raw_ocr_text");
    expect(html).toContain("<summary>Technical details</summary>");
    expect(html.indexOf("Question extraction returned malformed candidates")).toBeLessThan(html.indexOf("Technical details"));
    expect(html).not.toContain("Failure output");
  });
});

describe("provider cost helpers", () => {
  it("sums valid provider cost estimates with fixed precision", () => {
    expect(
      totalEstimatedCostUsd([
        { estimatedCostUsd: "0.004000" },
        { estimatedCostUsd: "0.000750" },
        { estimatedCostUsd: null }
      ])
    ).toBe("0.004750");
  });

  it("returns no total when no usable cost estimates exist", () => {
    expect(totalEstimatedCostUsd([{ estimatedCostUsd: null }, { estimatedCostUsd: "not-a-number" }])).toBeNull();
  });

  it("formats zero, sub-cent, regular, and missing provider costs", () => {
    expect(formatEstimatedCostUsd("0.000000")).toBe("$0.00");
    expect(formatEstimatedCostUsd("0.004750")).toBe("<$0.01");
    expect(formatEstimatedCostUsd("1.236000")).toBe("$1.24");
    expect(formatEstimatedCostUsd(null)).toBe("-");
  });
});
