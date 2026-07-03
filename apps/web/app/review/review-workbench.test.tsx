import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { ReviewWorkbench, shouldRemoveReviewItemAfterDecision } from "./review-workbench";

vi.stubGlobal("React", React);

describe("ReviewWorkbench", () => {
  it("shows the needs-more-info decision for open review work", () => {
    const html = renderToStaticMarkup(<ReviewWorkbench initialItems={[reviewItem]} />);

    expect(html).toContain("Needs info");
    expect(html).toContain("title=\"Needs more info\"");
  });

  it("renders signed diagram images for the selected review item", () => {
    const html = renderToStaticMarkup(
      <ReviewWorkbench
        initialItems={[
          {
            ...reviewItem,
            candidate: {
              ...reviewItem.candidate,
              questionType: "DIAGRAM",
              diagramAsset: {
                imageId: "img-1",
                label: "Circuit diagram",
                url: "https://r2.example/circuit.png"
              }
            }
          }
        ]}
      />
    );

    expect(html).toContain("<img");
    expect(html).toContain("src=\"https://r2.example/circuit.png\"");
    expect(html).toContain("alt=\"Circuit diagram\"");
  });
});

describe("shouldRemoveReviewItemAfterDecision", () => {
  it("keeps needs-more-info review work visible because it is still open", () => {
    expect(shouldRemoveReviewItemAfterDecision("NEEDS_MORE_INFO")).toBe(false);
  });

  it.each(["APPROVE", "EDIT_AND_APPROVE", "REJECT", "MARK_DUPLICATE", "MARK_UNPROCESSABLE"])(
    "removes terminal review decision %s from the local queue",
    (decision) => {
      expect(shouldRemoveReviewItemAfterDecision(decision)).toBe(true);
    }
  );
});

const reviewItem = {
  id: "review-item-1",
  reviewType: "answer_review",
  severity: "HIGH",
  reasonCodes: ["ANSWER_UNCERTAIN"],
  status: "OPEN",
  createdAt: "2026-07-02T00:00:00.000Z",
  reviewPayload: {
    sourceEvidence: {
      page: 1
    }
  },
  sourcePaper: {
    sourceFileName: "algebra-paper.pdf"
  },
  candidate: {
    id: "candidate-1",
    questionNumber: "1",
    questionType: "SHORT_ANSWER",
    rawOcrText: "1. Define inertia.",
    cleanedQuestionText: "Define inertia.",
    answerText: null,
    options: null,
    diagramAsset: null,
    solutionText: null,
    difficulty: null,
    marks: 2,
    overallConfidence: 0.72,
    fieldConfidence: {
      answer_text: 0.4
    },
    sourceEvidence: {
      page: 1
    }
  }
};
