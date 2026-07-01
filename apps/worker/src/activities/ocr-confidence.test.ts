import { describe, expect, it } from "vitest";

import { candidateOcrConfidence } from "./ocr-confidence.js";

const pages = [
  { pageNumber: 1, averageConfidence: 0.91, minimumConfidence: 0.82 },
  { pageNumber: 2, averageConfidence: 0.87, minimumConfidence: 0.58 },
  { pageNumber: 3, averageConfidence: 0.94, minimumConfidence: 0.9 }
];

describe("candidateOcrConfidence", () => {
  it("uses the candidate page when no explicit source range exists", () => {
    expect(
      candidateOcrConfidence(
        {
          pageNumber: 1,
          sourcePageStart: null,
          sourcePageEnd: null
        },
        pages
      )
    ).toEqual({
      averageConfidence: 0.91,
      minimumConfidence: 0.82
    });
  });

  it("summarizes source page ranges", () => {
    expect(
      candidateOcrConfidence(
        {
          pageNumber: null,
          sourcePageStart: 1,
          sourcePageEnd: 2
        },
        pages
      )
    ).toEqual({
      averageConfidence: 0.89,
      minimumConfidence: 0.58
    });
  });

  it("returns no OCR signal when the candidate has no page reference", () => {
    expect(
      candidateOcrConfidence(
        {
          pageNumber: null,
          sourcePageStart: null,
          sourcePageEnd: null
        },
        pages
      )
    ).toEqual({});
  });
});
