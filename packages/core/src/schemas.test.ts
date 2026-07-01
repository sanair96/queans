import { describe, expect, it } from "vitest";

import { maxUploadByteSize, uploadCompleteSchema, uploadInitSchema } from "./schemas.js";

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
