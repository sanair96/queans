import { describe, expect, it } from "vitest";

import { serializeWorkflowFailure } from "./workflow-failure.js";

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
});
