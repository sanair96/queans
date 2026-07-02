import { describe, expect, it } from "vitest";

import { CandidateStatus, ReviewStatus } from "@queans/db";

import {
  answerReviewStatusForCandidate,
  candidateUpdateForReviewedItem,
  reviewedItemToApplyWhere,
  reviewGateForConfidenceDecision,
  workflowCompletionPayload
} from "./app.activities.js";

describe("reviewGateForConfidenceDecision", () => {
  it("auto-approves clean candidates without creating review work", () => {
    expect(reviewGateForConfidenceDecision("AUTO_APPROVE")).toEqual({
      candidateStatus: CandidateStatus.APPROVED,
      createReviewItem: false,
      recordReviewReasons: false
    });
  });

  it("records optional field review reasons without blocking ingestion", () => {
    expect(reviewGateForConfidenceDecision("APPROVE_WITH_FIELD_REVIEW")).toEqual({
      candidateStatus: CandidateStatus.APPROVED,
      createReviewItem: false,
      recordReviewReasons: true
    });
  });

  it("creates review work for candidates that need human approval before ingestion", () => {
    expect(reviewGateForConfidenceDecision("NEEDS_REVIEW")).toEqual({
      candidateStatus: CandidateStatus.NEEDS_REVIEW,
      createReviewItem: true,
      recordReviewReasons: true
    });
  });

  it("rejects unprocessable candidates without creating review work", () => {
    expect(reviewGateForConfidenceDecision("REJECT")).toEqual({
      candidateStatus: CandidateStatus.REJECTED,
      createReviewItem: false,
      recordReviewReasons: true
    });
  });
});

describe("candidateUpdateForReviewedItem", () => {
  it("keeps reviewer-marked unusable candidates out of the bank with a distinct status", () => {
    expect(candidateUpdateForReviewedItem("REJECTED", "MARK_UNPROCESSABLE", null)).toEqual({
      reviewStatus: "UNPROCESSABLE"
    });
  });

  it("keeps reviewer rejections distinct from unusable candidates", () => {
    expect(candidateUpdateForReviewedItem("REJECTED", "REJECT", null)).toEqual({
      reviewStatus: "REJECTED"
    });
  });

  it("marks reviewer-approved candidates as human verified", () => {
    expect(candidateUpdateForReviewedItem("APPROVED", "APPROVE", null)).toEqual({
      reviewStatus: "APPROVED",
      answerSourceType: "HUMAN_VERIFIED",
      answerSourceBacked: true
    });
  });

  it("normalizes edited candidate text before approval", () => {
    expect(
      candidateUpdateForReviewedItem("EDITED", "EDIT_AND_APPROVE", {
        candidate: {
          cleanedQuestionText: "  Which gas do plants absorb?  ",
          questionType: "MCQ",
          options: [" Oxygen ", " Carbon dioxide ", "Nitrogen"],
          answerText: "  Carbon dioxide  ",
          solutionText: "   ",
          marks: 2,
          difficulty: "  easy  "
        }
      })
    ).toEqual({
      cleanedQuestionText: "Which gas do plants absorb?",
      questionType: "MCQ",
      options: ["Oxygen", "Carbon dioxide", "Nitrogen"],
      answerText: "Carbon dioxide",
      solutionText: null,
      marks: 2,
      difficulty: "easy",
      reviewStatus: "EDITED_AND_APPROVED",
      answerSourceType: "HUMAN_VERIFIED",
      answerSourceBacked: true
    });
  });

  it("applies reviewed diagram asset metadata", () => {
    expect(
      candidateUpdateForReviewedItem("EDITED", "EDIT_AND_APPROVE", {
        candidate: {
          cleanedQuestionText: "Label the flower.",
          questionType: "DIAGRAM",
          diagramAsset: {
            description: "Flower diagram from page 2",
            sourcePage: 2
          },
          answerText: "Sepal, petal, stamen, and pistil.",
          marks: 4
        }
      })
    ).toMatchObject({
      questionType: "DIAGRAM",
      diagramAsset: {
        description: "Flower diagram from page 2",
        sourcePage: 2
      },
      reviewStatus: "EDITED_AND_APPROVED"
    });
  });
});

describe("reviewedItemToApplyWhere", () => {
  it("selects only terminal, unapplied review items for workflow application", () => {
    expect(reviewedItemToApplyWhere({ ingestionRunId: "run-1", sourcePaperId: "source-paper-1" })).toEqual({
      workflowRunId: "run-1",
      status: {
        in: [ReviewStatus.APPROVED, ReviewStatus.EDITED, ReviewStatus.REJECTED, ReviewStatus.SKIPPED]
      },
      appliedAt: null
    });
  });
});

describe("answerReviewStatusForCandidate", () => {
  it("approves source-validated generated answers that pass candidate gating", () => {
    expect(
      answerReviewStatusForCandidate({
        answerSourceType: "LLM_GENERATED",
        answerSourceBacked: true
      })
    ).toBe(ReviewStatus.APPROVED);
  });

  it("keeps unvalidated generated answers open for answer review", () => {
    expect(
      answerReviewStatusForCandidate({
        answerSourceType: "LLM_GENERATED",
        answerSourceBacked: false
      })
    ).toBe(ReviewStatus.OPEN);
  });

  it("approves source-key and human-verified answers", () => {
    expect(
      answerReviewStatusForCandidate({
        answerSourceType: "SOURCE_KEY",
        answerSourceBacked: false
      })
    ).toBe(ReviewStatus.APPROVED);
    expect(
      answerReviewStatusForCandidate({
        answerSourceType: "HUMAN_VERIFIED",
        answerSourceBacked: false
      })
    ).toBe(ReviewStatus.APPROVED);
  });
});

describe("workflowCompletionPayload", () => {
  it("includes source paper identity with the final commit summary", () => {
    expect(
      workflowCompletionPayload(
        { ingestionRunId: "run-1", sourcePaperId: "source-paper-1" },
        { questionsCommitted: 3 }
      )
    ).toEqual({
      sourcePaperId: "source-paper-1",
      questionsCommitted: 3
    });
  });

  it("wraps non-object completion output", () => {
    expect(workflowCompletionPayload({ ingestionRunId: "run-1", sourcePaperId: "source-paper-1" }, "done")).toEqual({
      sourcePaperId: "source-paper-1",
      result: "done"
    });
  });
});
