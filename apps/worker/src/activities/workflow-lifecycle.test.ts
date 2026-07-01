import { describe, expect, it } from "vitest";

import { sourcePaperUpdateForStartedWorkflowStep } from "./app.activities.js";

describe("sourcePaperUpdateForStartedWorkflowStep", () => {
  it("marks the source paper as processing while workflow activities run", () => {
    expect(sourcePaperUpdateForStartedWorkflowStep()).toEqual({
      status: "PROCESSING"
    });
  });
});
