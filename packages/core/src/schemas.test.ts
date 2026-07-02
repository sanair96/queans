import { describe, expect, it } from "vitest";

import { maxUploadByteSize, reviewPatchSchema, uploadCompleteSchema, uploadInitSchema } from "./schemas.js";

describe("uploadCompleteSchema", () => {
  it("accepts paper context used to classify ingested source papers", () => {
    expect(
      uploadCompleteSchema.parse({
        byteSize: 4096,
        paperContext: {
          title: "Algebra midterm",
          board: "CBSE",
          classLevel: "10",
          subject: "Mathematics",
          year: 2026,
          schoolName: "Apex Academy",
          examType: "Midterm",
          uploadedBy: "test@test.com",
          metadata: { term: "Term 1" }
        }
      })
    ).toMatchObject({
      paperContext: {
        board: "CBSE",
        classLevel: "10",
        subject: "Mathematics",
        year: 2026
      }
    });
  });

  it("rejects implausible paper years", () => {
    expect(() =>
      uploadCompleteSchema.parse({
        paperContext: { year: 3026 }
      })
    ).toThrow();
  });
});

describe("uploadInitSchema", () => {
  it("accepts PDF uploads within the OCR size limit", () => {
    expect(
      uploadInitSchema.parse({
        fileName: "paper.pdf",
        mimeType: "application/pdf",
        byteSize: maxUploadByteSize
      })
    ).toMatchObject({
      mimeType: "application/pdf",
      byteSize: maxUploadByteSize
    });
  });

  it("rejects unsupported upload MIME types", () => {
    expect(() =>
      uploadInitSchema.parse({
        fileName: "paper.png",
        mimeType: "image/png",
        byteSize: 1024
      })
    ).toThrow("Only PDF uploads are supported by the current OCR pipeline.");
  });

  it("rejects files over the OCR size limit", () => {
    expect(() =>
      uploadInitSchema.parse({
        fileName: "large-paper.pdf",
        mimeType: "application/pdf",
        byteSize: maxUploadByteSize + 1
      })
    ).toThrow("Uploads must be 50 MB or smaller for OCR processing.");
  });
});

describe("reviewPatchSchema", () => {
  it("accepts review decisions that are implemented by the ingestion workflow", () => {
    for (const decision of [
      "APPROVE",
      "REJECT",
      "MARK_DUPLICATE",
      "NEEDS_MORE_INFO",
      "MARK_UNPROCESSABLE"
    ]) {
      expect(reviewPatchSchema.parse({ decision })).toEqual({ decision });
    }
  });

  it("rejects split and merge until candidate rewrite semantics are implemented", () => {
    expect(() => reviewPatchSchema.parse({ decision: "SPLIT" })).toThrow();
    expect(() => reviewPatchSchema.parse({ decision: "MERGE" })).toThrow();
  });

  it("accepts edit approval with non-empty candidate text and answer", () => {
    expect(
      reviewPatchSchema.parse({
        decision: "EDIT_AND_APPROVE",
        reviewPayload: {
          candidate: {
            cleanedQuestionText: "What is inertia?",
            questionType: "SHORT_ANSWER",
            options: null,
            answerText: "The tendency to resist change in motion.",
            solutionText: "",
            marks: 2,
            difficulty: "easy"
          }
        }
      })
    ).toMatchObject({
      decision: "EDIT_AND_APPROVE"
    });
  });

  it("accepts edit approval for MCQs with reviewed options", () => {
    expect(
      reviewPatchSchema.parse({
        decision: "EDIT_AND_APPROVE",
        reviewPayload: {
          candidate: {
            cleanedQuestionText: "Which gas do plants absorb?",
            questionType: "MCQ",
            options: ["Oxygen", "Carbon dioxide", "Nitrogen"],
            answerText: "Carbon dioxide",
            marks: 1
          }
        }
      })
    ).toMatchObject({
      decision: "EDIT_AND_APPROVE"
    });
  });

  it("accepts edit approval for diagram questions with reviewed asset metadata", () => {
    expect(
      reviewPatchSchema.parse({
        decision: "EDIT_AND_APPROVE",
        reviewPayload: {
          candidate: {
            cleanedQuestionText: "Label the parts of the flower.",
            questionType: "DIAGRAM",
            diagramAsset: {
              description: "Flower diagram from page 2",
              sourcePage: 2
            },
            answerText: "Sepal, petal, stamen, and pistil.",
            marks: 4
          }
        }
      })
    ).toMatchObject({
      decision: "EDIT_AND_APPROVE"
    });
  });

  it("rejects edit approval with blank candidate text or answer", () => {
    expect(() =>
      reviewPatchSchema.parse({
        decision: "EDIT_AND_APPROVE",
        reviewPayload: {
          candidate: {
            cleanedQuestionText: " ",
            questionType: "SHORT_ANSWER",
            answerText: "Valid answer",
            marks: 2
          }
        }
      })
    ).toThrow("Question text is required for edit approval.");

    expect(() =>
      reviewPatchSchema.parse({
        decision: "EDIT_AND_APPROVE",
        reviewPayload: {
          candidate: {
            cleanedQuestionText: "Valid question",
            questionType: "SHORT_ANSWER",
            answerText: "",
            marks: 2
          }
        }
      })
    ).toThrow("Answer text is required for edit approval.");
  });

  it("rejects edit approval without a resolved question type", () => {
    expect(() =>
      reviewPatchSchema.parse({
        decision: "EDIT_AND_APPROVE",
        reviewPayload: {
          candidate: {
            cleanedQuestionText: "Valid question",
            questionType: "UNKNOWN",
            answerText: "Valid answer",
            marks: 2
          }
        }
      })
    ).toThrow("Question type is required for edit approval.");
  });

  it("rejects edit approval without resolved marks", () => {
    expect(() =>
      reviewPatchSchema.parse({
        decision: "EDIT_AND_APPROVE",
        reviewPayload: {
          candidate: {
            cleanedQuestionText: "Valid question",
            questionType: "SHORT_ANSWER",
            answerText: "Valid answer",
            marks: null
          }
        }
      })
    ).toThrow("Marks are required for edit approval.");
  });

  it("rejects MCQ edit approval without reviewed options", () => {
    expect(() =>
      reviewPatchSchema.parse({
        decision: "EDIT_AND_APPROVE",
        reviewPayload: {
          candidate: {
            cleanedQuestionText: "Which gas do plants absorb?",
            questionType: "MCQ",
            answerText: "Carbon dioxide",
            marks: 1
          }
        }
      })
    ).toThrow("MCQ options are required for edit approval.");
  });

  it("rejects MCQ edit approval with too few options", () => {
    expect(() =>
      reviewPatchSchema.parse({
        decision: "EDIT_AND_APPROVE",
        reviewPayload: {
          candidate: {
            cleanedQuestionText: "Which gas do plants absorb?",
            questionType: "MCQ",
            options: ["Carbon dioxide"],
            answerText: "Carbon dioxide",
            marks: 1
          }
        }
      })
    ).toThrow("MCQ options require at least two choices.");
  });

  it("does not require edit payloads for non-edit decisions", () => {
    expect(reviewPatchSchema.parse({ decision: "APPROVE" })).toEqual({ decision: "APPROVE" });
  });
});
