import { describe, expect, it } from "vitest";

import { uploadCompleteSchema } from "./schemas.js";

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
