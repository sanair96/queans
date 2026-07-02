import { describe, expect, it } from "vitest";

import { Prisma, ReviewStatus } from "@queans/db";

import {
  canPatchReviewItem,
  ingestionFailureSummary,
  ingestionRunCounts,
  ingestionQueuedPayload,
  isAuthorizedInternalRequest,
  isActiveIngestionStatus,
  isPrismaUniqueConstraintError,
  mutableReviewItemWhere,
  openReviewItemsWhere,
  paperContextPayloadFromSourcePaper,
  paperIngestionInputPayload,
  reviewApprovalConflictPayload,
  reviewEditApprovalConflictPayload,
  reviewItemAlreadyClosedPayload,
  reviewItemUpdateData,
  reviewReasonCodesFromJson,
  reviewSignalRunForItem,
  sourcePaperCanQueueIngestionWhere,
  sourcePaperQueuedForIngestionUpdate,
  uploadCompletionConflict,
  uploadCompletionPayload
} from "./routes.js";

const apiConfig = {
  TEMPORAL_TASK_QUEUE_PAPER_INGESTION: "paper-ingestion",
  TEMPORAL_TASK_QUEUE_OCR: "paper-ocr",
  TEMPORAL_TASK_QUEUE_LLM: "paper-llm-extraction"
};

describe("uploadCompletionPayload", () => {
  it("returns the latest ingestion run for an already completed upload", () => {
    expect(
      uploadCompletionPayload({
        id: "source-paper-1",
        workflowRuns: [
          { id: "run-new", status: "RUNNING" },
          { id: "run-old", status: "FAILED" }
        ]
      })
    ).toEqual({
      sourcePaperId: "source-paper-1",
      ingestionRunId: "run-new",
      status: "RUNNING"
    });
  });

  it("keeps a completed upload response stable when the workflow run is not visible yet", () => {
    expect(
      uploadCompletionPayload({
        id: "source-paper-1",
        workflowRuns: []
      })
    ).toEqual({
      sourcePaperId: "source-paper-1",
      ingestionRunId: undefined,
      status: "PENDING"
    });
  });
});

describe("paperIngestionInputPayload", () => {
  it("captures R2 object identity, paper context, and Temporal queues for audit/debugging", () => {
    expect(
      paperIngestionInputPayload({
        sourcePaperId: "source-paper-1",
        uploadObjectId: "upload-1",
        objectKey: "source-papers/2026-07-02/paper.pdf",
        paperContext: {
          board: "CBSE",
          classLevel: "10",
          subject: "Mathematics"
        },
        config: apiConfig
      })
    ).toEqual({
      sourcePaperId: "source-paper-1",
      uploadObjectId: "upload-1",
      objectKey: "source-papers/2026-07-02/paper.pdf",
      paperContext: {
        board: "CBSE",
        classLevel: "10",
        subject: "Mathematics"
      },
      taskQueues: {
        paperIngestion: "paper-ingestion",
        ocr: "paper-ocr",
        llm: "paper-llm-extraction"
      }
    });
  });
});

describe("paperContextPayloadFromSourcePaper", () => {
  it("rebuilds paper context from stored source paper fields for manual ingestion runs", () => {
    expect(
      paperContextPayloadFromSourcePaper({
        title: "Algebra Midterm",
        board: "CBSE",
        classLevel: "10",
        subject: "Mathematics",
        year: 2026,
        schoolName: "Apex Academy",
        examType: "Midterm",
        uploadedBy: "test@test.com",
        metadata: { term: "Term 1" }
      })
    ).toEqual({
      title: "Algebra Midterm",
      board: "CBSE",
      classLevel: "10",
      subject: "Mathematics",
      year: 2026,
      schoolName: "Apex Academy",
      examType: "Midterm",
      uploadedBy: "test@test.com",
      metadata: { term: "Term 1" }
    });
  });

  it("returns null when a source paper has no stored paper context", () => {
    expect(
      paperContextPayloadFromSourcePaper({
        title: null,
        board: null,
        classLevel: null,
        subject: null,
        year: null,
        schoolName: null,
        examType: null,
        uploadedBy: null,
        metadata: null
      })
    ).toBeNull();
  });
});

describe("uploadCompletionConflict", () => {
  it("accepts matching R2 object metadata", () => {
    expect(
      uploadCompletionConflict({
        head: {
          byteSize: 1024,
          contentType: "application/pdf",
          etag: "etag-1"
        },
        reportedByteSize: 1024,
        storedByteSize: 1024n,
        storedMimeType: "application/pdf"
      })
    ).toBeUndefined();
  });

  it("rejects client-reported byte size mismatches before ingestion", () => {
    expect(
      uploadCompletionConflict({
        head: {
          byteSize: 1024,
          contentType: "application/pdf"
        },
        reportedByteSize: 512,
        storedByteSize: 1024n,
        storedMimeType: "application/pdf"
      })
    ).toEqual({ error: "UPLOAD_SIZE_MISMATCH" });
  });

  it("rejects stored R2 object byte size mismatches before ingestion", () => {
    expect(
      uploadCompletionConflict({
        head: {
          byteSize: 2048,
          contentType: "application/pdf"
        },
        reportedByteSize: undefined,
        storedByteSize: 1024n,
        storedMimeType: "application/pdf"
      })
    ).toEqual({ error: "R2_OBJECT_SIZE_MISMATCH" });
  });

  it("rejects missing or non-PDF R2 content types before ingestion", () => {
    expect(
      uploadCompletionConflict({
        head: {
          byteSize: 1024
        },
        reportedByteSize: 1024,
        storedByteSize: 1024n,
        storedMimeType: "application/pdf"
      })
    ).toEqual({
      error: "R2_OBJECT_CONTENT_TYPE_MISMATCH",
      expectedMimeType: "application/pdf",
      actualMimeType: null
    });

    expect(
      uploadCompletionConflict({
        head: {
          byteSize: 1024,
          contentType: "image/png"
        },
        reportedByteSize: 1024,
        storedByteSize: 1024n,
        storedMimeType: "application/pdf"
      })
    ).toEqual({
      error: "R2_OBJECT_CONTENT_TYPE_MISMATCH",
      expectedMimeType: "application/pdf",
      actualMimeType: "image/png"
    });
  });
});

describe("isPrismaUniqueConstraintError", () => {
  it("detects Prisma unique constraint errors", () => {
    expect(
      isPrismaUniqueConstraintError(
        new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: "test"
        })
      )
    ).toBe(true);
  });

  it("does not treat other Prisma errors as unique constraint races", () => {
    expect(
      isPrismaUniqueConstraintError(
        new Prisma.PrismaClientKnownRequestError("Missing row", {
          code: "P2025",
          clientVersion: "test"
        })
      )
    ).toBe(false);
  });
});

describe("isActiveIngestionStatus", () => {
  it("treats unfinished ingestion statuses as active", () => {
    expect(isActiveIngestionStatus("PENDING")).toBe(true);
    expect(isActiveIngestionStatus("RUNNING")).toBe(true);
    expect(isActiveIngestionStatus("WAITING_FOR_REVIEW")).toBe(true);
  });

  it("does not treat terminal ingestion statuses as active", () => {
    expect(isActiveIngestionStatus("COMPLETED")).toBe(false);
    expect(isActiveIngestionStatus("FAILED")).toBe(false);
    expect(isActiveIngestionStatus("CANCELLED")).toBe(false);
  });
});

describe("sourcePaperCanQueueIngestionWhere", () => {
  it("claims only source papers that are not already in an active ingestion state", () => {
    expect(sourcePaperCanQueueIngestionWhere("source-paper-1")).toEqual({
      id: "source-paper-1",
      status: { in: ["UPLOADED", "COMPLETED", "FAILED", "CANCELLED"] }
    });
  });
});

describe("sourcePaperQueuedForIngestionUpdate", () => {
  it("moves a claimed source paper into the queued state", () => {
    expect(sourcePaperQueuedForIngestionUpdate()).toEqual({
      status: "QUEUED"
    });
  });
});

describe("isAuthorizedInternalRequest", () => {
  it("accepts the configured internal token header", () => {
    expect(
      isAuthorizedInternalRequest(
        {
          "x-queans-internal-token": "test-internal-token"
        },
        { INTERNAL_API_TOKEN: "test-internal-token" }
      )
    ).toBe(true);
  });

  it("rejects missing, mismatched, and length-mismatched tokens", () => {
    expect(isAuthorizedInternalRequest({}, { INTERNAL_API_TOKEN: "test-internal-token" })).toBe(false);
    expect(
      isAuthorizedInternalRequest(
        {
          "x-queans-internal-token": "wrong-internal-token"
        },
        { INTERNAL_API_TOKEN: "test-internal-token" }
      )
    ).toBe(false);
    expect(
      isAuthorizedInternalRequest(
        {
          "x-queans-internal-token": "short"
        },
        { INTERNAL_API_TOKEN: "test-internal-token" }
      )
    ).toBe(false);
  });
});

describe("ingestionQueuedPayload", () => {
  it("maps pending workflow runs to the public queued status", () => {
    expect(ingestionQueuedPayload({ id: "run-1", status: "PENDING" })).toEqual({
      ingestionRunId: "run-1",
      status: "QUEUED"
    });
  });

  it("returns active non-pending workflow statuses unchanged", () => {
    expect(ingestionQueuedPayload({ id: "run-1", status: "WAITING_FOR_REVIEW" })).toEqual({
      ingestionRunId: "run-1",
      status: "WAITING_FOR_REVIEW"
    });
  });
});

describe("ingestionRunCounts", () => {
  it("uses run-scoped review counts with source-paper OCR and candidate counts", () => {
    expect(
      ingestionRunCounts(
        {
          questionCandidates: 12,
          reviewItems: 7,
          ocrPages: 4
        },
        2
      )
    ).toEqual({
      questionCandidates: 12,
      reviewItems: 2,
      ocrPages: 4
    });
  });
});

describe("ingestionFailureSummary", () => {
  it("summarizes extraction schema failures and attaches matching provider cost metadata", () => {
    expect(
      ingestionFailureSummary({
        currentStep: "extract_question_candidates",
        errorPayload: {
          name: "ApplicationFailure",
          message: "Mistral extraction response did not match the required candidate schema.",
          cause: {
            name: "ZodError",
            message: "ZodError",
            stack: `ZodError: [
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
  }
]`
          }
        },
        providerRunCosts: [
          { provider: "MISTRAL", model: "mistral-ocr-latest", operation: "ocr" },
          { provider: "MISTRAL", model: "mistral-small-latest", operation: "question_extraction" }
        ]
      })
    ).toMatchObject({
      title: "Question extraction returned malformed candidates",
      detail: "Question extraction returned malformed candidates: 1 candidate is missing required fields.",
      failedStep: "extract_question_candidates",
      failureType: "ZodError",
      rootCause: "ZodError",
      provider: "MISTRAL",
      model: "mistral-small-latest",
      issues: [
        {
          field: "cleaned_question_text",
          candidateIndex: 0
        }
      ]
    });
  });

  it("returns null for runs without an error payload", () => {
    expect(ingestionFailureSummary({ errorPayload: null })).toBeNull();
  });

  it("does not attach OCR provider metadata to extraction failures", () => {
    const summary = ingestionFailureSummary({
      currentStep: "extract_question_candidates",
      errorPayload: { name: "Error", message: "Invalid extraction response" },
      providerRunCosts: [{ provider: "MISTRAL", model: "mistral-ocr-latest", operation: "ocr" }]
    });

    expect(summary).toMatchObject({
      title: "Workflow failed",
      rootCause: "Invalid extraction response"
    });
    expect(summary).not.toMatchObject({
      provider: "MISTRAL",
      model: "mistral-ocr-latest"
    });
  });
});

describe("canPatchReviewItem", () => {
  it("allows open and assigned review work that has not been applied", () => {
    expect(canPatchReviewItem({ status: ReviewStatus.OPEN, appliedAt: null })).toBe(true);
    expect(canPatchReviewItem({ status: ReviewStatus.ASSIGNED, appliedAt: null })).toBe(true);
  });

  it("rejects terminal or already-applied review work", () => {
    expect(canPatchReviewItem({ status: ReviewStatus.APPROVED, appliedAt: null })).toBe(false);
    expect(canPatchReviewItem({ status: ReviewStatus.OPEN, appliedAt: new Date("2026-07-01T10:20:30.000Z") })).toBe(
      false
    );
  });
});

describe("mutableReviewItemWhere", () => {
  it("matches only unapplied open or assigned review work for write-time guarding", () => {
    expect(mutableReviewItemWhere("review-item-1")).toEqual({
      id: "review-item-1",
      status: { in: [ReviewStatus.OPEN, ReviewStatus.ASSIGNED] },
      appliedAt: null
    });
  });
});

describe("reviewItemUpdateData", () => {
  const reviewedAt = new Date("2026-07-02T10:20:30.000Z");

  it("preserves the existing review payload when a decision omits reviewPayload", () => {
    const data = reviewItemUpdateData(
      {
        decision: "NEEDS_MORE_INFO",
        reviewedBy: "reviewer-1",
        reviewNotes: "Need source answer key confirmation."
      },
      reviewedAt
    );

    expect(data).toEqual({
      status: ReviewStatus.ASSIGNED,
      reviewedBy: "reviewer-1",
      reviewNotes: "Need source answer key confirmation.",
      decision: "NEEDS_MORE_INFO",
      reviewedAt
    });
    expect(data).not.toHaveProperty("reviewPayload");
  });

  it("clears the review payload only when reviewPayload is explicitly null", () => {
    expect(
      reviewItemUpdateData(
        {
          decision: "REJECT",
          reviewPayload: null
        },
        reviewedAt
      )
    ).toEqual({
      status: ReviewStatus.REJECTED,
      reviewedBy: null,
      reviewNotes: null,
      reviewPayload: null,
      decision: "REJECT",
      reviewedAt
    });
  });

  it("stores edited candidate payloads for edit approval decisions", () => {
    const reviewPayload = {
      candidate: {
        cleanedQuestionText: "Define inertia.",
        questionType: "SHORT_ANSWER",
        answerText: "The tendency to resist change in motion.",
        marks: 2
      }
    };

    expect(
      reviewItemUpdateData(
        {
          decision: "EDIT_AND_APPROVE",
          reviewPayload
        },
        reviewedAt
      )
    ).toMatchObject({
      status: ReviewStatus.EDITED,
      reviewPayload,
      decision: "EDIT_AND_APPROVE",
      reviewedAt
    });
  });
});

describe("reviewApprovalConflictPayload", () => {
  const completeCandidate = {
    cleanedQuestionText: "What is photosynthesis?",
    answerText: "Photosynthesis converts light energy into chemical energy.",
    questionType: "SHORT_ANSWER",
    marks: 2
  };

  it("blocks direct approval when the candidate is incomplete as-is", () => {
    expect(
      reviewApprovalConflictPayload({
        reasonCodes: [],
        candidate: {
          cleanedQuestionText: " ",
          answerText: null,
          questionType: "UNKNOWN",
          marks: null
        }
      })
    ).toEqual({
      error: "REVIEW_APPROVAL_REQUIRES_EDIT",
      message:
        "Direct approval can only ingest complete candidates as-is. Edit and approve, reject, mark duplicate, request more info, or mark this review item unprocessable.",
      missingFields: ["cleanedQuestionText", "answerText", "questionType", "marks"],
      blockingReasons: []
    });
  });

  it("blocks direct approval for hard validation reasons that require another decision or edit", () => {
    expect(
      reviewApprovalConflictPayload({
        reasonCodes: ["MCQ_OPTIONS_MISSING", { code: "DIAGRAM_ASSET_MISSING" }, "LOW_OCR_CONFIDENCE"],
        candidate: completeCandidate
      })
    ).toMatchObject({
      error: "REVIEW_APPROVAL_REQUIRES_EDIT",
      missingFields: [],
      blockingReasons: ["MCQ_OPTIONS_MISSING", "DIAGRAM_ASSET_MISSING"]
    });
  });

  it("allows direct approval for complete candidates that only need human confidence confirmation", () => {
    expect(
      reviewApprovalConflictPayload({
        reasonCodes: [
          "LOW_OCR_CONFIDENCE",
          "LOW_FIELD_CONFIDENCE",
          "VALIDATION_FAILED",
          "LOW_ANSWER_CONFIDENCE",
          "ANSWER_UNCERTAIN",
          "LLM_GENERATED_ANSWER_UNVERIFIED",
          "TOPIC_AMBIGUOUS",
          "TOPIC_NOT_MAPPED"
        ],
        candidate: completeCandidate
      })
    ).toBeUndefined();
  });
});

describe("reviewReasonCodesFromJson", () => {
  it("extracts known review reason strings from mixed JSON payloads", () => {
    expect(
      reviewReasonCodesFromJson([
        "MISSING_REQUIRED_FIELD",
        { code: "LOW_TOPIC_CONFIDENCE" },
        { code: "NOT_A_REASON" },
        { value: "VALIDATION_FAILED" },
        null
      ])
    ).toEqual(["MISSING_REQUIRED_FIELD", "LOW_TOPIC_CONFIDENCE"]);
  });

  it("returns an empty list for non-array reason payloads", () => {
    expect(reviewReasonCodesFromJson(null)).toEqual([]);
  });
});

describe("reviewEditApprovalConflictPayload", () => {
  it("blocks edited approval for structural reasons the edit form cannot resolve", () => {
    expect(
      reviewEditApprovalConflictPayload(
        {
          reasonCodes: ["MCQ_OPTIONS_MISSING", "DIAGRAM_ASSET_MISSING", "MISSING_MARKS"]
        },
        {
          candidate: {
            questionType: "DIAGRAM"
          }
        }
      )
    ).toEqual({
      error: "REVIEW_EDIT_APPROVAL_REQUIRES_STRUCTURAL_FIX",
      message:
        "Save edits cannot resolve this review item's structural requirements yet. Use another review decision or add structural editor support before approving.",
      blockingReasons: ["DIAGRAM_ASSET_MISSING"]
    });
  });

  it("allows edited approval when schema-backed fields can resolve the review reasons", () => {
    expect(
      reviewEditApprovalConflictPayload({
        reasonCodes: ["MISSING_REQUIRED_FIELD", "MISSING_MARKS", "MCQ_OPTIONS_MISSING", "LOW_FIELD_CONFIDENCE"]
      })
    ).toBeUndefined();
  });

  it("allows edited approval when a diagram asset is supplied", () => {
    expect(
      reviewEditApprovalConflictPayload(
        {
          reasonCodes: ["DIAGRAM_ASSET_MISSING"]
        },
        {
          candidate: {
            diagramAsset: {
              description: "Diagram crop on page 2"
            }
          }
        }
      )
    ).toBeUndefined();
  });

  it("does not treat blank diagram asset text as supplied metadata", () => {
    expect(
      reviewEditApprovalConflictPayload(
        {
          reasonCodes: ["DIAGRAM_ASSET_MISSING"]
        },
        {
          candidate: {
            diagramAsset: " "
          }
        }
      )
    ).toMatchObject({
      error: "REVIEW_EDIT_APPROVAL_REQUIRES_STRUCTURAL_FIX",
      blockingReasons: ["DIAGRAM_ASSET_MISSING"]
    });
  });
});

describe("openReviewItemsWhere", () => {
  it("shows only open work attached to active paper-ingestion runs", () => {
    expect(openReviewItemsWhere()).toEqual({
      status: { in: [ReviewStatus.OPEN, ReviewStatus.ASSIGNED] },
      workflowRun: {
        workflowType: "PAPER_INGESTION",
        status: { in: ["PENDING", "RUNNING", "WAITING_FOR_REVIEW"] }
      }
    });
  });
});

describe("reviewSignalRunForItem", () => {
  it("returns the review item's active ingestion run for wakeups", () => {
    expect(
      reviewSignalRunForItem({
        workflowRun: {
          id: "run-1",
          status: "WAITING_FOR_REVIEW"
        }
      })
    ).toEqual({
      id: "run-1",
      status: "WAITING_FOR_REVIEW"
    });
  });

  it("does not signal terminal ingestion runs", () => {
    expect(
      reviewSignalRunForItem({
        workflowRun: {
          id: "run-1",
          status: "COMPLETED"
        }
      })
    ).toBeUndefined();
  });
});

describe("reviewItemAlreadyClosedPayload", () => {
  it("returns a stable conflict payload for closed review work", () => {
    expect(
      reviewItemAlreadyClosedPayload({
        status: ReviewStatus.APPROVED,
        appliedAt: new Date("2026-07-01T10:20:30.000Z")
      })
    ).toEqual({
      error: "REVIEW_ITEM_ALREADY_CLOSED",
      status: ReviewStatus.APPROVED,
      appliedAt: "2026-07-01T10:20:30.000Z"
    });
  });
});
