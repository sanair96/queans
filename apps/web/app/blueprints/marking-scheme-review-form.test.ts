import { describe, expect, it } from "vitest";

import { formatQuestionRangeForDisplay, groupQuestionIndexForReview } from "./marking-scheme-review-form";

describe("teacher Blueprint review helpers", () => {
  it("groups subquestions under their top-level parent", () => {
    const groups = groupQuestionIndexForReview([
      question("1", 10, [], [1]),
      question("1(a)", 2, [], [1, 2]),
      question("1(b)", 3, ["either"], [3]),
      question("2", 5, [], [4])
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      number: "1",
      marks: 10,
      part_labels: ["a", "b"],
      alternative_labels: ["either"],
      source_pages: [1, 2, 3]
    });
  });

  it("uses parent metadata when a legacy draft lists a child first", () => {
    const groups = groupQuestionIndexForReview([
      question("Q1(a)", 2, [], [2]),
      question("Q1", 10, [], [1])
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ number: "1", marks: 10, part_labels: ["a"], source_pages: [1, 2] });
  });

  it("compacts only contiguous numeric ranges", () => {
    expect(formatQuestionRangeForDisplay("1, 2, 3, 4, 5")).toBe("1–5");
    expect(formatQuestionRangeForDisplay("1-5")).toBe("1–5");
    expect(formatQuestionRangeForDisplay("1, 3, 5")).toBe("1, 3, 5");
    expect(formatQuestionRangeForDisplay("1 OR 2")).toBe("1 OR 2");
  });
});

function question(number: string, marks: number, alternatives: string[], sourcePages: number[]) {
  return {
    number,
    section: "Section A",
    marks,
    question_type: "Short answer",
    part_labels: [],
    alternative_labels: alternatives,
    source_pages: sourcePages
  };
}
