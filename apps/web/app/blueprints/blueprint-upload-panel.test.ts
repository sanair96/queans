import { describe, expect, it } from "vitest";

import { blueprintUploadFileValidationMessage, formatFileSize } from "./blueprint-upload-panel";

describe("Blueprint upload file validation", () => {
  it("uses the Blueprint uploader document policy", () => {
    expect(blueprintUploadFileValidationMessage({ type: "application/pdf", size: 50 * 1024 * 1024 })).toBeUndefined();
    expect(blueprintUploadFileValidationMessage({ type: "image/png", size: 100 })).toBe(
      "Only PDF, DOCX, PPTX, or ODT uploads are supported."
    );
  });

  it("keeps absent and oversize-file guidance actionable", () => {
    expect(blueprintUploadFileValidationMessage(null)).toBe("Choose a PDF, DOCX, PPTX, or ODT document before uploading.");
    expect(blueprintUploadFileValidationMessage({ type: "application/pdf", size: 50 * 1024 * 1024 + 1 })).toBe(
      "Choose a PDF, DOCX, PPTX, or ODT document that is 50 MB or smaller."
    );
  });

  it("formats selected-file sizes for the document ticket", () => {
    expect(formatFileSize(900)).toBe("1 KB");
    expect(formatFileSize(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(formatFileSize(12 * 1024 * 1024)).toBe("12 MB");
  });
});
