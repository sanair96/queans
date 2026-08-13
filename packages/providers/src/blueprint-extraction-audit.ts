import type { BlueprintSkeleton, MarkingSchemeRules, QuestionScheme } from "./blueprint-extraction-contract.js";
import type {
  BlueprintExtractionAudit,
  BlueprintExtractionAuditConflict,
  BlueprintStructuredOcrPage
} from "./types.js";

export interface BlueprintRecoveryPlan {
  questionNumbers: string[];
  pageNumbers: number[];
  pages: BlueprintStructuredOcrPage[];
}

export function auditBlueprintExtraction(input: {
  skeleton: BlueprintSkeleton;
  questionSchemes: QuestionScheme[];
  questionMarkingScheme: MarkingSchemeRules["question_marking_scheme"];
}): BlueprintExtractionAudit {
  const parsedSections = input.skeleton.assessment_blueprint.sections.map((section) => ({
    section,
    questionNumbers: section.question_range ? parseUnambiguousNumericQuestionRange(section.question_range) : null
  }));
  const expectedQuestionNumbers = sortedQuestionNumbers(unique(parsedSections.flatMap(({ questionNumbers }) => questionNumbers ?? [])));
  const extractedQuestionNumbers = sortedQuestionNumbers(unique(input.questionMarkingScheme.map((question) => canonicalQuestionNumber(question.number))));
  const extracted = new Set(extractedQuestionNumbers);
  const missingQuestionNumbers = expectedQuestionNumbers.filter((questionNumber) => !extracted.has(questionNumber));
  const evidence = input.questionSchemes.flatMap((scheme) => scheme.question_marking_scheme);
  const evidenceByNumber = groupBy(evidence, (question) => canonicalQuestionNumber(question.number));
  const duplicateQuestionNumbers = sortedQuestionNumbers(
    [...evidenceByNumber.entries()].filter(([, questions]) => questions.length > 1).map(([questionNumber]) => questionNumber)
  );
  const conflicts = questionConflicts(input.skeleton, evidenceByNumber, input.questionMarkingScheme);
  const markReconciliation = reconcileBlueprintMarks(input.skeleton, input.questionMarkingScheme, parsedSections);
  const unparseableRanges = parsedSections.flatMap(({ section, questionNumbers }) =>
    section.question_range && questionNumbers === null
      ? [{ sectionName: section.name, questionRange: section.question_range, sourcePages: sortedNumbers(section.source_pages) }]
      : []
  );
  return {
    reconciled:
      missingQuestionNumbers.length === 0 &&
      duplicateQuestionNumbers.length === 0 &&
      conflicts.length === 0 &&
      markReconciliation.status !== "MISMATCH",
    expectedQuestionNumbers,
    extractedQuestionNumbers,
    missingQuestionNumbers,
    duplicateQuestionNumbers,
    conflicts,
    markReconciliation,
    unparseableRanges
  };
}

export function buildBlueprintRecoveryPlan(input: {
  audit: BlueprintExtractionAudit;
  skeleton: BlueprintSkeleton;
  pages: BlueprintStructuredOcrPage[];
  markingSchemePageNumbers?: number[] | undefined;
}): BlueprintRecoveryPlan | null {
  if (input.audit.missingQuestionNumbers.length === 0) return null;
  const pageByNumber = new Map(input.pages.map((page) => [page.pageNumber, page]));
  const markingPageNumbers = sortedNumbers(
    unique((input.markingSchemePageNumbers?.length ? input.markingSchemePageNumbers : input.pages.map((page) => page.pageNumber)).filter((pageNumber) => pageByNumber.has(pageNumber)))
  );
  if (markingPageNumbers.length === 0) return null;
  const markingPages = new Set(markingPageNumbers);
  const missing = new Set(input.audit.missingQuestionNumbers);
  const affected = new Set<number>();

  for (const question of input.skeleton.question_index) {
    if (missing.has(canonicalQuestionNumber(question.number))) {
      for (const pageNumber of question.source_pages) if (markingPages.has(pageNumber)) affected.add(pageNumber);
    }
  }
  for (const section of input.skeleton.assessment_blueprint.sections) {
    const range = section.question_range ? parseUnambiguousNumericQuestionRange(section.question_range) : null;
    if (range?.some((questionNumber) => missing.has(questionNumber))) {
      for (const pageNumber of section.source_pages) if (markingPages.has(pageNumber)) affected.add(pageNumber);
    }
  }
  for (const page of input.pages) {
    if (!markingPages.has(page.pageNumber)) continue;
    const searchableText = [page.markdown, page.plainText ?? "", ...(page.blocks ?? []).map((block) => block.text)].join("\n");
    if ([...missing].some((questionNumber) => new RegExp(`(?:^|[^0-9])${escapeRegExp(questionNumber)}(?:[^0-9]|$)`, "u").test(searchableText))) {
      affected.add(page.pageNumber);
    }
  }
  if (affected.size === 0) return null;

  const selected = new Set<number>();
  for (const affectedPage of affected) {
    const index = markingPageNumbers.indexOf(affectedPage);
    for (const pageNumber of markingPageNumbers.slice(Math.max(0, index - 1), index + 2)) selected.add(pageNumber);
  }
  const pageNumbers = sortedNumbers([...selected]);
  return {
    questionNumbers: input.audit.missingQuestionNumbers,
    pageNumbers,
    pages: pageNumbers.flatMap((pageNumber) => pageByNumber.get(pageNumber) ?? [])
  };
}

export function blueprintExtractionAuditWarnings(audit: BlueprintExtractionAudit): string[] {
  return [
    ...(audit.missingQuestionNumbers.length > 0 ? [`Missing expected question schemes: ${audit.missingQuestionNumbers.join(", ")}.`] : []),
    ...(audit.duplicateQuestionNumbers.length > 0 ? [`Duplicate question evidence was returned for: ${audit.duplicateQuestionNumbers.join(", ")}.`] : []),
    ...audit.conflicts.map((conflict) => `Conflicting ${conflict.field} evidence for question ${conflict.questionNumber}: ${conflict.values.join(" vs ")}.`),
    ...(audit.markReconciliation.status === "MISMATCH"
      ? [`Extracted question marks (${audit.markReconciliation.extractedTotalMarks}) do not reconcile with declared total marks (${audit.markReconciliation.declaredTotalMarks}).`]
      : []),
    ...audit.unparseableRanges.map((range) => `Question range "${range.questionRange}" in section ${range.sectionName} is complex or unparseable; completeness is advisory for this range.`)
  ];
}

/** Returns null unless every token is an unambiguous positive numeric item or inclusive range. */
export function parseUnambiguousNumericQuestionRange(value: string): string[] | null {
  const normalized = value
    .trim()
    .replace(/^(?:questions?|ques?\.?|q\.?s?\.?)\s*/iu, "")
    .replace(/[–—]/gu, "-")
    .replace(/\bto\b/giu, "-");
  if (!/^\d+(?:\s*-\s*\d+)?(?:\s*,\s*\d+(?:\s*-\s*\d+)?)*$/u.test(normalized)) return null;
  const questionNumbers: string[] = [];
  for (const token of normalized.split(",")) {
    const [startText, endText] = token.split("-").map((part) => part?.trim());
    const start = Number(startText);
    const end = endText === undefined ? start : Number(endText);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start <= 0 || end < start || end - start > 1_000) return null;
    for (let questionNumber = start; questionNumber <= end; questionNumber += 1) questionNumbers.push(String(questionNumber));
  }
  return unique(questionNumbers);
}

function questionConflicts(
  skeleton: BlueprintSkeleton,
  evidenceByNumber: Map<string, QuestionScheme["question_marking_scheme"]>,
  mergedQuestions: MarkingSchemeRules["question_marking_scheme"]
) {
  const conflicts: BlueprintExtractionAuditConflict[] = [];
  const skeletonByNumber = new Map(skeleton.question_index.map((question) => [canonicalQuestionNumber(question.number), question]));
  const mergedByNumber = new Map(mergedQuestions.map((question) => [canonicalQuestionNumber(question.number), question]));
  const allNumbers = unique([...evidenceByNumber.keys(), ...skeletonByNumber.keys()]);
  for (const questionNumber of allNumbers) {
    const evidence = evidenceByNumber.get(questionNumber) ?? [];
    const expected = skeletonByNumber.get(questionNumber);
    const merged = mergedByNumber.get(questionNumber);
    const marks = unique([
      ...(expected?.marks === null || expected?.marks === undefined ? [] : [expected.marks]),
      ...evidence.flatMap((question) => question.marks === null ? [] : [question.marks])
    ]);
    if (marks.length > 1) conflicts.push({ questionNumber, field: "marks", values: marks, sourcePages: evidencePages(expected, evidence, merged) });
    const sections = unique([
      ...(expected?.section ? [expected.section] : []),
      ...evidence.flatMap((question) => question.section ? [question.section] : [])
    ], normalizedText);
    if (sections.length > 1) conflicts.push({ questionNumber, field: "section", values: sections, sourcePages: evidencePages(expected, evidence, merged) });
  }
  return conflicts.sort((left, right) => compareQuestionNumbers(left.questionNumber, right.questionNumber) || left.field.localeCompare(right.field));
}

function reconcileBlueprintMarks(
  skeleton: BlueprintSkeleton,
  questions: MarkingSchemeRules["question_marking_scheme"],
  parsedSections: Array<{ section: BlueprintSkeleton["assessment_blueprint"]["sections"][number]; questionNumbers: string[] | null }>
) {
  const declaredTotalMarks = skeleton.assessment_blueprint.total_marks ?? skeleton.document_metadata.total_marks;
  const countedQuestions = new Set<string>();
  const choiceAdjustedSections: string[] = [];
  let extractedTotalMarks = 0;
  let unavailable = false;
  for (const { section, questionNumbers } of parsedSections) {
    const range = new Set(questionNumbers ?? []);
    const sectionQuestions = questions.filter((question) =>
      !countedQuestions.has(canonicalQuestionNumber(question.number)) && (
        (question.section !== null && normalizedText(question.section) === normalizedText(section.name)) ||
        (range.size > 0 && range.has(canonicalQuestionNumber(question.number)))
      )
    );
    if (sectionQuestions.length === 0) continue;
    const questionMarks = sectionQuestions.map(effectiveQuestionMarks);
    const attemptCount = deterministicAttemptCount(section.choice_rules);
    if (attemptCount !== null) {
      const known = questionMarks.filter((marks): marks is number => marks !== null);
      if (known.length !== questionMarks.length || new Set(known).size !== 1 || attemptCount > known.length) unavailable = true;
      else {
        extractedTotalMarks += attemptCount * known[0]!;
        choiceAdjustedSections.push(section.name);
      }
    } else if (questionMarks.some((marks) => marks === null)) unavailable = true;
    else extractedTotalMarks += questionMarks.reduce<number>((total, marks) => total + (marks ?? 0), 0);
    for (const question of sectionQuestions) countedQuestions.add(canonicalQuestionNumber(question.number));
  }
  for (const question of questions) {
    if (countedQuestions.has(canonicalQuestionNumber(question.number))) continue;
    const marks = effectiveQuestionMarks(question);
    if (marks === null) unavailable = true;
    else extractedTotalMarks += marks;
  }
  const extracted = unavailable ? null : extractedTotalMarks;
  const status = declaredTotalMarks === null || extracted === null
    ? "UNAVAILABLE" as const
    : Math.abs(declaredTotalMarks - extracted) < 0.000_001 ? "MATCH" as const : "MISMATCH" as const;
  return { status, declaredTotalMarks, extractedTotalMarks: extracted, choiceAdjustedSections: unique(choiceAdjustedSections, normalizedText) };
}

function effectiveQuestionMarks(question: MarkingSchemeRules["question_marking_scheme"][number]): number | null {
  if (question.marks !== null) return question.marks;
  if (question.parts.length > 0 && question.parts.every((part) => part.marks !== null)) {
    return question.parts.reduce((total, part) => total + (part.marks ?? 0), 0);
  }
  const alternativeMarks = question.alternatives.flatMap((alternative) => alternative.marks === null ? [] : [alternative.marks]);
  return alternativeMarks.length === question.alternatives.length && alternativeMarks.length > 0 && new Set(alternativeMarks).size === 1
    ? alternativeMarks[0]!
    : null;
}

function deterministicAttemptCount(choiceRules: string[]): number | null {
  for (const rule of choiceRules) {
    const match = /\b(?:attempt|answer)\s+(?:any\s+)?(?<count>\d+)\b/iu.exec(rule);
    const count = Number(match?.groups?.count);
    if (Number.isSafeInteger(count) && count > 0) return count;
  }
  return null;
}

function evidencePages(
  expected: BlueprintSkeleton["question_index"][number] | undefined,
  evidence: QuestionScheme["question_marking_scheme"],
  merged: MarkingSchemeRules["question_marking_scheme"][number] | undefined
) {
  return sortedNumbers(unique([...(expected?.source_pages ?? []), ...evidence.flatMap((question) => question.source_pages), ...(merged?.source_pages ?? [])]));
}

function canonicalQuestionNumber(value: string) {
  const trimmed = value.trim();
  return /^\d+$/u.test(trimmed) ? String(Number(trimmed)) : trimmed;
}

function sortedQuestionNumbers(values: string[]) {
  return [...values].sort(compareQuestionNumbers);
}

function compareQuestionNumbers(left: string, right: string) {
  const leftNumber = /^\d+$/u.test(left) ? Number(left) : Number.NaN;
  const rightNumber = /^\d+$/u.test(right) ? Number(right) : Number.NaN;
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
  if (Number.isFinite(leftNumber)) return -1;
  if (Number.isFinite(rightNumber)) return 1;
  return left.localeCompare(right, undefined, { numeric: true });
}

function sortedNumbers(values: number[]) {
  return [...values].sort((left, right) => left - right);
}

function normalizedText(value: string) {
  return value.trim().toLocaleLowerCase();
}

function groupBy<T>(values: T[], key: (value: T) => string) {
  const grouped = new Map<string, T[]>();
  for (const value of values) grouped.set(key(value), [...(grouped.get(key(value)) ?? []), value]);
  return grouped;
}

function unique<T>(values: T[], key: (value: T) => unknown = (value) => value) {
  const seen = new Set<unknown>();
  return values.filter((value) => {
    const identity = key(value);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
