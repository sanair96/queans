import { describe, expect, it } from "vitest";

import { uploadFileValidationMessage } from "./upload-panel";

describe("uploadFileValidationMessage", () => {
  it("requires a file before upload", () => {
    expect(uploadFileValidationMessage(null)).toBe("Choose a PDF before uploading.");
  });

  it("accepts PDF uploads at the current OCR size limit", () => {
    expect(uploadFileValidationMessage({ type: "application/pdf", size: 50 * 1024 * 1024 })).toBeUndefined();
  });

  it("rejects non-PDF uploads", () => {
    expect(uploadFileValidationMessage({ type: "image/png", size: 1024 })).toBe("Only PDF uploads are supported.");
  });

  it("rejects files larger than the OCR limit", () => {
    expect(uploadFileValidationMessage({ type: "application/pdf", size: 50 * 1024 * 1024 + 1 })).toBe(
      "Choose a PDF that is 50 MB or smaller."
    );
  });
});
