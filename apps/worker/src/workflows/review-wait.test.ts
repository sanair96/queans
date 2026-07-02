import { describe, expect, it } from "vitest";

import { humanReviewRecheckInterval, shouldWaitForHumanReviewSignal } from "./review-wait.js";

describe("shouldWaitForHumanReviewSignal", () => {
  it("uses a bounded wait so lost review signals cannot strand the workflow indefinitely", () => {
    expect(humanReviewRecheckInterval).toBe("1 minute");
  });

  it("does not wait when review items were cleared before entering the condition", () => {
    expect(
      shouldWaitForHumanReviewSignal({
        reviewStillOpen: false,
        previousSignalCount: 0,
        currentSignalCount: 0
      })
    ).toBe(false);
  });

  it("does not wait when a signal has already arrived for the current review cycle", () => {
    expect(
      shouldWaitForHumanReviewSignal({
        reviewStillOpen: true,
        previousSignalCount: 1,
        currentSignalCount: 2
      })
    ).toBe(false);
  });

  it("waits when review is still open and no new signal arrived", () => {
    expect(
      shouldWaitForHumanReviewSignal({
        reviewStillOpen: true,
        previousSignalCount: 1,
        currentSignalCount: 1
      })
    ).toBe(true);
  });
});
