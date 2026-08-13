import { describe, expect, it } from "vitest";

import type { BlueprintSkeleton, MarkingSchemeRules, QuestionScheme } from "./blueprint-extraction-contract.js";
import {
  auditBlueprintExtraction,
  buildBlueprintRecoveryPlan,
  parseUnambiguousNumericQuestionRange
} from "./blueprint-extraction-audit.js";

describe("Blueprint extraction completeness audit", () => {
  it("reconciles a complete numeric question range", () => {
    const skeleton = skeletonFor({ range: "1-2", totalMarks: 10, questionMarks: [5, 5] });
    const questions = [question("1", 5, 1), question("2", 5, 2)];
    const result = audit(skeleton, [{ question_marking_scheme: questions }], questions);

    expect(result).toMatchObject({
      reconciled: true,
      expectedQuestionNumbers: ["1", "2"],
      extractedQuestionNumbers: ["1", "2"],
      missingQuestionNumbers: [],
      duplicateQuestionNumbers: [],
      conflicts: [],
      markReconciliation: { status: "MATCH", declaredTotalMarks: 10, extractedTotalMarks: 10 }
    });
  });

  it("reports missing questions and selects affected plus adjacent marking pages", () => {
    const skeleton = skeletonFor({ range: "1-3", totalMarks: 15, questionMarks: [5, 5, 5] });
    const questions = [question("1", 5, 1), question("3", 5, 3)];
    const result = audit(skeleton, [{ question_marking_scheme: questions }], questions);
    const recovery = buildBlueprintRecoveryPlan({
      audit: result,
      skeleton,
      pages: [1, 2, 3, 4].map((pageNumber) => ({ pageNumber, markdown: `Question ${pageNumber}` })),
      markingSchemePageNumbers: [1, 2, 3, 4]
    });

    expect(result.missingQuestionNumbers).toEqual(["2"]);
    expect(result.reconciled).toBe(false);
    expect(recovery).toMatchObject({ questionNumbers: ["2"], pageNumbers: [1, 2, 3] });
  });

  it("flags duplicate question evidence even after evidence-aware merging", () => {
    const skeleton = skeletonFor({ range: "1", totalMarks: 5, questionMarks: [5] });
    const first = question("1", 5, 1);
    const duplicate = { ...question("1", 5, 2), value_points: ["Equivalent evidence"] };
    const result = audit(skeleton, [{ question_marking_scheme: [first] }, { question_marking_scheme: [duplicate] }], [{ ...first, source_pages: [1, 2] }]);

    expect(result.duplicateQuestionNumbers).toEqual(["1"]);
    expect(result.reconciled).toBe(false);
  });

  it("reconciles deterministic section choice marks without double-counting all options", () => {
    const skeleton = skeletonFor({ range: "1-5", totalMarks: 8, questionMarks: [2, 2, 2, 2, 2], choiceRules: ["Attempt any 4 of 5 questions."] });
    const questions = [1, 2, 3, 4, 5].map((number) => question(String(number), 2, number));
    const result = audit(skeleton, [{ question_marking_scheme: questions }], questions);

    expect(result.markReconciliation).toEqual({ status: "MATCH", declaredTotalMarks: 8, extractedTotalMarks: 8, choiceAdjustedSections: ["Section A"] });
    expect(result.reconciled).toBe(true);
    expect(parseUnambiguousNumericQuestionRange("1 OR 2")).toBeNull();
  });

  it("marks total-mark mismatches as unreconciled", () => {
    const skeleton = skeletonFor({ range: "1-2", totalMarks: 10, questionMarks: [4, 4] });
    const questions = [question("1", 4, 1), question("2", 4, 2)];
    const result = audit(skeleton, [{ question_marking_scheme: questions }], questions);

    expect(result.markReconciliation).toEqual({ status: "MISMATCH", declaredTotalMarks: 10, extractedTotalMarks: 8, choiceAdjustedSections: [] });
    expect(result.reconciled).toBe(false);
  });

  it("keeps complex ranges advisory instead of creating automatic missing questions", () => {
    const skeleton = skeletonFor({ range: "1 OR 2", totalMarks: 5, questionMarks: [5] });
    const questions = [question("1", 5, 1)];
    const result = audit(skeleton, [{ question_marking_scheme: questions }], questions);

    expect(result.expectedQuestionNumbers).toEqual([]);
    expect(result.missingQuestionNumbers).toEqual([]);
    expect(result.unparseableRanges).toEqual([{ sectionName: "Section A", questionRange: "1 OR 2", sourcePages: [1] }]);
    expect(result.reconciled).toBe(true);
  });
});

function audit(
  skeleton: BlueprintSkeleton,
  questionSchemes: QuestionScheme[],
  questionMarkingScheme: MarkingSchemeRules["question_marking_scheme"]
) {
  return auditBlueprintExtraction({ skeleton, questionSchemes, questionMarkingScheme });
}

function skeletonFor(input: { range: string; totalMarks: number; questionMarks: number[]; choiceRules?: string[] }): BlueprintSkeleton {
  return {
    document_metadata: { title: null, subject: null, examination: null, paper_code: null, session: null, total_marks: input.totalMarks, source_pages: [1] },
    evaluation_rules: [],
    assessment_blueprint: {
      sections: [{ name: "Section A", question_range: input.range, question_type: null, choice_rules: input.choiceRules ?? [], declared_marks: input.totalMarks, source_pages: [1] }],
      total_marks: input.totalMarks,
      source_pages: [1]
    },
    question_index: input.questionMarks.map((marks, index) => ({ number: String(index + 1), section: "Section A", marks, part_labels: [], alternative_labels: [], source_pages: [index + 1] }))
  };
}

function question(number: string, marks: number, sourcePage: number): MarkingSchemeRules["question_marking_scheme"][number] {
  return { number, section: "Section A", marks, parts: [], alternatives: [], value_points: [], acceptable_answers: [], marking_notes: [], source_pages: [sourcePage] };
}
