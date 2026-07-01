import { describe, expect, it } from "vitest";

import { CandidateStatus } from "@queans/db";

import { candidateUpdateForReviewedItem, reviewGateForConfidenceDecision } from "./app.activities.js";

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
});
