import { describe, expect, it } from "vitest";

import { apiErrorDetail, apiErrorMessage } from "./api-errors";

describe("apiErrorDetail", () => {
  it("formats validation issues with paths", () => {
    expect(
      apiErrorDetail({
        error: "VALIDATION_ERROR",
        issues: [
          {
            path: ["reviewPayload", "candidate", "answerText"],
            message: "Answer text is required for edit approval."
          }
        ]
      })
    ).toBe("reviewPayload.candidate.answerText: Answer text is required for edit approval.");
  });

  it("formats R2 content type mismatches", () => {
    expect(
      apiErrorDetail({
        error: "R2_OBJECT_CONTENT_TYPE_MISMATCH",
        expectedMimeType: "application/pdf",
        actualMimeType: "image/png"
      })
    ).toBe("Uploaded file type image/png did not match expected application/pdf.");
  });

  it("formats already-closed review items", () => {
    expect(
      apiErrorDetail({
        error: "REVIEW_ITEM_ALREADY_CLOSED",
        status: "APPROVED"
      })
    ).toBe("This review item is already approved.");
  });

  it("formats direct approval conflicts with missing fields and structural reasons", () => {
    expect(
      apiErrorDetail({
        error: "REVIEW_APPROVAL_REQUIRES_EDIT",
        missingFields: ["cleanedQuestionText", "answerText", "marks"],
        blockingReasons: ["MCQ_OPTIONS_MISSING"]
      })
    ).toBe(
      "Approve as-is needs a complete candidate. Use Save edits after fixing question text, answer text, and marks. Resolve MCQ options missing before approving."
    );
  });

  it("formats edited approval conflicts for unsupported structural fixes", () => {
    expect(
      apiErrorDetail({
        error: "REVIEW_EDIT_APPROVAL_REQUIRES_STRUCTURAL_FIX",
        blockingReasons: ["MCQ_OPTIONS_MISSING", "DIAGRAM_ASSET_MISSING"]
      })
    ).toBe(
      "Save edits cannot approve this item yet. Resolve MCQ options missing and diagram asset missing before approving. Use another review decision until this structural editor is available."
    );
  });

  it("falls back to response messages and humanized error codes", () => {
    expect(apiErrorDetail({ message: "Missing required environment variable: R2_ACCOUNT_ID" })).toBe(
      "Missing required environment variable: R2_ACCOUNT_ID"
    );
    expect(apiErrorDetail({ error: "INGESTION_RUN_NOT_FOUND" })).toBe("Ingestion Run Not Found");
  });
});

describe("apiErrorMessage", () => {
  it("includes the action and parsed JSON error detail", async () => {
    await expect(
      apiErrorMessage(
        new Response(
          JSON.stringify({
            error: "UPLOAD_SIZE_MISMATCH"
          }),
          {
            status: 409,
            headers: { "content-type": "application/json" }
          }
        ),
        "Upload verification"
      )
    ).resolves.toBe("Upload verification failed: Uploaded file size did not match the completed upload request.");
  });

  it("formats R2 XML errors", async () => {
    await expect(
      apiErrorMessage(
        new Response(
          "<Error><Code>SignatureDoesNotMatch</Code><Message>The request signature was invalid.</Message></Error>",
          {
            status: 403,
            headers: { "content-type": "application/xml" }
          }
        ),
        "R2 upload"
      )
    ).resolves.toBe("R2 upload failed: SignatureDoesNotMatch: The request signature was invalid.");
  });

  it("formats plain text errors and only falls back to status for empty errors", async () => {
    await expect(
      apiErrorMessage(
        new Response("Server unavailable", {
          status: 503,
          headers: { "content-type": "text/plain" }
        }),
        "Run lookup"
      )
    ).resolves.toBe("Run lookup failed: Server unavailable");

    await expect(
      apiErrorMessage(
        new Response("", {
          status: 503,
          headers: { "content-type": "text/plain" }
        }),
        "Run lookup"
      )
    ).resolves.toBe("Run lookup failed with 503");
  });
});
