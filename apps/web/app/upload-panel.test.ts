import { describe, expect, it } from "vitest";

import { uploadFileValidationMessage } from "./upload-panel";

describe("uploadFileValidationMessage", () => {
  it("requires a file before upload", () => {
    expect(uploadFileValidationMessage(null)).toBe("Choose a PDF, DOCX, PPTX, or ODT document before uploading.");
  });

  it.each([
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.oasis.opendocument.text"
  ])("accepts %s uploads at the current OCR size limit", (type) => {
    expect(uploadFileValidationMessage({ type, size: 50 * 1024 * 1024 })).toBeUndefined();
  });

  it("rejects unsupported uploads", () => {
    expect(uploadFileValidationMessage({ type: "image/png", size: 1024 })).toBe(
      "Only PDF, DOCX, PPTX, or ODT uploads are supported."
    );
  });

  it("rejects files larger than the OCR limit", () => {
    expect(uploadFileValidationMessage({ type: "application/pdf", size: 50 * 1024 * 1024 + 1 })).toBe(
      "Choose a PDF, DOCX, PPTX, or ODT document that is 50 MB or smaller."
    );
  });
});
