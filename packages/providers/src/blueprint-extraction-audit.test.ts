import { describe, expect, it } from "vitest";

import type { BlueprintSkeleton } from "./blueprint-extraction-contract.js";
import { auditBlueprintExtraction, buildBlueprintRecoveryPlan, extractBlueprintQuestionInventory, parseUnambiguousNumericQuestionRange } from "./blueprint-extraction-audit.js";

describe("structural Blueprint coverage", () => {
  it("builds a question inventory without retaining question prose", () => {
    const inventory = extractBlueprintQuestionInventory([
      { pageNumber: 1, markdown: "Section A\n1. Explain the process.\n(a) First part\n(b) Second part\n2) Another question." },
      { pageNumber: 2, markdown: "Question 3\nAnswer any one." }
    ]);

    expect(inventory).toEqual([
      { number: "1", partLabels: ["a", "b"], alternativeLabels: [], sourcePages: [1], evidence: ["1."] },
      { number: "2", partLabels: [], alternativeLabels: [], sourcePages: [1], evidence: ["2)"] },
      { number: "3", partLabels: [], alternativeLabels: [], sourcePages: [2], evidence: ["Question 3"] }
    ]);
    expect(JSON.stringify(inventory)).not.toContain("Explain the process");
  });

  it("does not promote years or mark allocations to questions", () => {
    const inventory = extractBlueprintQuestionInventory([{ pageNumber: 1, markdown: "2024. Annual assessment\n1. 5 marks\nQ2. Draw a diagram" }]);
    expect(inventory.map((entry) => entry.number)).toEqual(["2"]);
  });

  it("reconciles inventory, section ranges, and structural output", () => {
    const skeleton = skeletonFor("1-3", [1, 2, 3], 15);
    const inventory = extractBlueprintQuestionInventory([{ pageNumber: 1, markdown: "1.\n2.\n3." }]);
    const result = auditBlueprintExtraction({ skeleton, inventory, observedQuestionNumbers: ["1", "2", "3"] });
    expect(result).toMatchObject({ reconciled: true, inventoryQuestionNumbers: ["1", "2", "3"], expectedQuestionNumbers: ["1", "2", "3"], missingQuestionNumbers: [] });
  });

  it("reports missing questions and selects affected plus adjacent pages", () => {
    const skeleton = skeletonFor("1-3", [1, 3], 15);
    const inventory = extractBlueprintQuestionInventory([1, 2, 3, 4].map((pageNumber) => ({ pageNumber, markdown: pageNumber === 2 ? "Question 2" : `Question ${pageNumber}` })));
    const result = auditBlueprintExtraction({ skeleton, inventory, observedQuestionNumbers: ["1", "3"] });
    const recovery = buildBlueprintRecoveryPlan({ audit: result, inventory, pages: [1, 2, 3, 4].map((pageNumber) => ({ pageNumber, markdown: `Question ${pageNumber}` })) });
    expect(result.missingQuestionNumbers).toEqual(["2", "4"]);
    expect(recovery).toMatchObject({ questionNumbers: ["2", "4"], pageNumbers: [1, 2, 3, 4] });
  });

  it("flags duplicate and conflicting structural evidence", () => {
    const first = question("1", 5, 1);
    const second = { ...question("1", 6, 2), section: "Section B" };
    const skeleton = { ...skeletonFor("1", [5], 5), question_index: [first, second] };
    const result = auditBlueprintExtraction({ skeleton, inventory: [{ number: "1", partLabels: [], alternativeLabels: [], sourcePages: [1, 2], evidence: [] }], observedQuestionNumbers: ["1", "1"] });
    expect(result.duplicateQuestionNumbers).toEqual(["1"]);
    expect(result.conflicts.map((conflict) => conflict.field)).toEqual(["section", "marks"]);
    expect(result.reconciled).toBe(false);
  });

  it("keeps complex OR ranges advisory", () => {
    const skeleton = skeletonFor("1 OR 2", [1], 5);
    const result = auditBlueprintExtraction({ skeleton, inventory: [], observedQuestionNumbers: ["1"] });
    expect(result.expectedQuestionNumbers).toEqual([]);
    expect(result.unparseableRanges).toEqual([{ sectionName: "Section A", questionRange: "1 OR 2", sourcePages: [1] }]);
    expect(parseUnambiguousNumericQuestionRange("1 OR 2")).toBeNull();
  });
});

function skeletonFor(range: string, numbers: number[], totalMarks: number): BlueprintSkeleton {
  return {
    document_metadata: { title: null, subject: null, examination: null, paper_code: null, session: null, total_marks: totalMarks, source_pages: [1] },
    evaluation_rules: [],
    assessment_blueprint: { sections: [{ name: "Section A", printed_identifier: null, question_range: range, question_type: null, choice_rules: [], declared_marks: totalMarks, source_pages: [1] }], total_marks: totalMarks, source_pages: [1] },
    question_index: numbers.map((number) => question(String(number), 5, number))
  };
}

function question(number: string, marks: number, sourcePage: number) {
  return { number, section: "Section A", marks, question_type: null, part_labels: [], alternative_labels: [], source_pages: [sourcePage] };
}
