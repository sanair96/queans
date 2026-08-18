import type { BlueprintQuestionIndexEntry, BlueprintSkeleton } from "./blueprint-extraction-contract.js";
import type {
  BlueprintExtractionAudit,
  BlueprintExtractionAuditConflict,
  BlueprintStructuredOcrPage
} from "./types.js";

export interface BlueprintQuestionInventoryEntry {
  number: string;
  partLabels: string[];
  alternativeLabels: string[];
  sourcePages: number[];
  evidence: string[];
}

export interface BlueprintRecoveryPlan {
  questionNumbers: string[];
  pageNumbers: number[];
  pages: BlueprintStructuredOcrPage[];
}

/** Finds structural question markers without retaining question prose. */
export function extractBlueprintQuestionInventory(pages: BlueprintStructuredOcrPage[]): BlueprintQuestionInventoryEntry[] {
  const entries = new Map<string, BlueprintQuestionInventoryEntry>();
  for (const page of pages) {
    const lines = [
      ...page.markdown.split(/\r?\n/u),
      ...(page.blocks ?? []).map((block) => block.text)
    ];
    let current: BlueprintQuestionInventoryEntry | undefined;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      const topLevel = questionMarker(line);
      if (topLevel) {
        const number = canonicalQuestionNumber(topLevel.number);
        current = entries.get(number) ?? { number, partLabels: [], alternativeLabels: [], sourcePages: [], evidence: [] };
        current.sourcePages = uniqueNumbers([...current.sourcePages, page.pageNumber]);
        // Keep only the structural marker. The OCR line itself can contain copied
        // question prose and must never flow into the structural Blueprint.
        current.evidence = uniqueStrings([...current.evidence, line.slice(0, topLevel.end).trim()]);
        const inlineParts = partLabels(line.slice(topLevel.end));
        current.partLabels = uniqueStrings([...current.partLabels, ...inlineParts]);
        if (/\b(?:or|either|alternative)\b/iu.test(line)) current.alternativeLabels = uniqueStrings([...current.alternativeLabels, ...inlineParts]);
        entries.set(number, current);
        continue;
      }
      if (!current) continue;
      const parts = partLabels(line);
      if (parts.length > 0) {
        current.partLabels = uniqueStrings([...current.partLabels, ...parts]);
        if (/\b(?:or|either|alternative)\b/iu.test(line)) current.alternativeLabels = uniqueStrings([...current.alternativeLabels, ...parts]);
        current.sourcePages = uniqueNumbers([...current.sourcePages, page.pageNumber]);
      }
    }
  }
  return [...entries.values()].sort((left, right) => compareQuestionNumbers(left.number, right.number));
}

export function auditBlueprintExtraction(input: {
  skeleton: BlueprintSkeleton;
  inventory: BlueprintQuestionInventoryEntry[];
  observedQuestionNumbers?: string[];
}): BlueprintExtractionAudit {
  const parsedSections = input.skeleton.assessment_blueprint.sections.map((section) => ({ section, questionNumbers: section.question_range ? parseUnambiguousNumericQuestionRange(section.question_range) : null }));
  const inventoryQuestionNumbers = input.inventory.map((question) => question.number);
  const expectedQuestionNumbers = sortedQuestionNumbers(unique([
    ...inventoryQuestionNumbers,
    ...parsedSections.flatMap(({ questionNumbers }) => questionNumbers ?? [])
  ]));
  const extractedQuestionNumbers = sortedQuestionNumbers(unique(input.skeleton.question_index.map((question) => canonicalQuestionNumber(question.number))));
  const extracted = new Set(extractedQuestionNumbers);
  const missingQuestionNumbers = expectedQuestionNumbers.filter((questionNumber) => !extracted.has(questionNumber));
  const duplicateQuestionNumbers = sortedQuestionNumbers(duplicates(input.observedQuestionNumbers ?? input.skeleton.question_index.map((question) => question.number)));
  const conflicts = questionConflicts(input.skeleton.question_index);
  const unparseableRanges = parsedSections.flatMap(({ section, questionNumbers }) => section.question_range && questionNumbers === null ? [{ sectionName: section.name, questionRange: section.question_range, sourcePages: sortedNumbers(section.source_pages) }] : []);
  const markReconciliation = reconcileBlueprintMarks(input.skeleton, parsedSections);
  return {
    reconciled: missingQuestionNumbers.length === 0 && duplicateQuestionNumbers.length === 0 && conflicts.length === 0 && markReconciliation.status !== "MISMATCH",
    inventoryQuestionNumbers: sortedQuestionNumbers(unique(inventoryQuestionNumbers)),
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
  inventory: BlueprintQuestionInventoryEntry[];
  pages: BlueprintStructuredOcrPage[];
}): BlueprintRecoveryPlan | null {
  if (input.audit.missingQuestionNumbers.length === 0) return null;
  const pageByNumber = new Map(input.pages.map((page) => [page.pageNumber, page]));
  const inventoryByNumber = new Map(input.inventory.map((question) => [question.number, question]));
  const affected = new Set<number>();
  for (const questionNumber of input.audit.missingQuestionNumbers) {
    for (const pageNumber of inventoryByNumber.get(questionNumber)?.sourcePages ?? []) affected.add(pageNumber);
  }
  for (const page of input.pages) {
    const searchableText = [page.markdown, page.plainText ?? "", ...(page.blocks ?? []).map((block) => block.text)].join("\n");
    if (input.audit.missingQuestionNumbers.some((questionNumber) => questionMarker(searchableText)?.number === questionNumber || new RegExp(`(?:^|[^0-9])${escapeRegExp(questionNumber)}(?:[^0-9]|$)`, "u").test(searchableText))) affected.add(page.pageNumber);
  }
  if (affected.size === 0) return null;
  const pageNumbers = sortedNumbers([...affected].flatMap((pageNumber) => {
    const sorted = [...pageByNumber.keys()].sort((left, right) => left - right);
    const index = sorted.indexOf(pageNumber);
    return sorted.slice(Math.max(0, index - 1), index + 2);
  }));
  return { questionNumbers: input.audit.missingQuestionNumbers, pageNumbers, pages: pageNumbers.flatMap((pageNumber) => pageByNumber.get(pageNumber) ?? []) };
}

export function blueprintExtractionAuditWarnings(audit: BlueprintExtractionAudit): string[] {
  return [
    ...(audit.missingQuestionNumbers.length > 0 ? [`Missing structural question numbers: ${audit.missingQuestionNumbers.join(", ")}.`] : []),
    ...(audit.duplicateQuestionNumbers.length > 0 ? [`Duplicate structural question evidence was returned for: ${audit.duplicateQuestionNumbers.join(", ")}.`] : []),
    ...audit.conflicts.map((conflict) => `Conflicting ${conflict.field} evidence for question ${conflict.questionNumber}: ${conflict.values.join(" vs ")}.`),
    ...(audit.markReconciliation.status === "MISMATCH" ? [`Extracted question marks (${audit.markReconciliation.extractedTotalMarks}) do not reconcile with declared total marks (${audit.markReconciliation.declaredTotalMarks}).`] : []),
    ...audit.unparseableRanges.map((range) => `Question range "${range.questionRange}" in section ${range.sectionName} is complex or unparseable; completeness is advisory for this range.`)
  ];
}

/** Returns null unless every token is an unambiguous positive numeric item or inclusive range. */
export function parseUnambiguousNumericQuestionRange(value: string): string[] | null {
  const normalized = value.trim().replace(/^(?:questions?|ques?\.?|q\.?s?\.?)\s*/iu, "").replace(/[–—]/gu, "-").replace(/\bto\b/giu, "-");
  if (!/^\d+(?:\s*-\s*\d+)?(?:\s*,\s*\d+(?:\s*-\s*\d+)?)*$/u.test(normalized)) return null;
  const questionNumbers: string[] = [];
  for (const token of normalized.split(",")) {
    const [startText, endText] = token.split("-").map((part) => part?.trim());
    const start = Number(startText); const end = endText === undefined ? start : Number(endText);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start <= 0 || end < start || end - start > 1_000) return null;
    for (let questionNumber = start; questionNumber <= end; questionNumber += 1) questionNumbers.push(String(questionNumber));
  }
  return unique(questionNumbers);
}

function questionMarker(line: string) {
  const match = line.match(/^\s*(?:question|ques|q)\s*([0-9]{1,4})(?=\s|[.):]|$)/iu) ?? line.match(/^\s*([0-9]{1,4})\s*[.)](?=\s|$)/u);
  if (!match) return undefined;
  const explicitLabel = /^(?:question|ques|q)/iu.test(match[0].trim());
  const remainder = line.slice(match[0].length).trim();
  const numericNumber = Number(match[1]);
  if (!explicitLabel && (numericNumber >= 1900 && numericNumber <= 2100 || /^(?:[=×x%]|\d+\s*(?:marks?|pts?|points?|अंक|गुण))/iu.test(remainder))) return undefined;
  return { number: match[1]!, end: match[0].length };
}

function partLabels(line: string) {
  return [...line.matchAll(/(?:^|\s|\()([a-z]|[ivx]{1,5})[.)](?=\s|$)/giu)].map((match) => match[1]!.toLowerCase());
}

function questionConflicts(questions: BlueprintQuestionIndexEntry[]): BlueprintExtractionAuditConflict[] {
  const byNumber = new Map<string, BlueprintQuestionIndexEntry[]>();
  for (const question of questions) byNumber.set(canonicalQuestionNumber(question.number), [...(byNumber.get(canonicalQuestionNumber(question.number)) ?? []), question]);
  const conflicts: BlueprintExtractionAuditConflict[] = [];
  for (const [questionNumber, values] of byNumber) {
    const sections = unique(values.map((value) => value.section).filter((value): value is string => Boolean(value)));
    if (sections.length > 1) conflicts.push({ questionNumber, field: "section", values: sections, sourcePages: sortedNumbers(unique(values.flatMap((value) => value.source_pages))) });
    const marks = unique(values.map((value) => value.marks).filter((value): value is number => value !== null));
    if (marks.length > 1) conflicts.push({ questionNumber, field: "marks", values: marks, sourcePages: sortedNumbers(unique(values.flatMap((value) => value.source_pages))) });
  }
  return conflicts;
}

function reconcileBlueprintMarks(skeleton: BlueprintSkeleton, sections: Array<{ section: BlueprintSkeleton["assessment_blueprint"]["sections"][number]; questionNumbers: string[] | null }>) {
  const declaredTotalMarks = skeleton.assessment_blueprint.total_marks ?? skeleton.document_metadata.total_marks;
  const questions = skeleton.question_index;
  if (declaredTotalMarks === null || questions.some((question) => question.marks === null)) return { status: "UNAVAILABLE" as const, declaredTotalMarks, extractedTotalMarks: null, choiceAdjustedSections: [] };
  const rawTotalMarks = questions.reduce((total, question) => total + (question.marks ?? 0), 0);
  let choiceAdjustedTotal = rawTotalMarks;
  const choiceAdjustedSections: string[] = [];
  for (const { section, questionNumbers } of sections) {
    if (section.choice_rules.length === 0 || !questionNumbers) continue;
    const sectionQuestions = questions.filter((question) => questionNumbers.includes(canonicalQuestionNumber(question.number)));
    const attemptCount = choiceAttemptCount(section.choice_rules);
    const marks = sectionQuestions.map((question) => question.marks).filter((mark): mark is number => mark !== null);
    if (attemptCount !== null && marks.length > 0 && new Set(marks).size === 1) {
      choiceAdjustedTotal -= marks.reduce((total, mark) => total + mark, 0);
      choiceAdjustedTotal += Math.min(attemptCount, marks.length) * marks[0]!;
      choiceAdjustedSections.push(section.name);
    }
  }
  const rawMatches = Math.abs(declaredTotalMarks - rawTotalMarks) < 0.000001;
  const choiceMatches = Math.abs(declaredTotalMarks - choiceAdjustedTotal) < 0.000001;
  return {
    status: rawMatches || choiceMatches ? "MATCH" as const : "MISMATCH" as const,
    declaredTotalMarks,
    extractedTotalMarks: choiceMatches && !rawMatches ? choiceAdjustedTotal : rawTotalMarks,
    choiceAdjustedSections
  };
}

function choiceAttemptCount(rules: string[]) {
  const text = rules.join(" ").toLocaleLowerCase();
  if (/\b(?:any|attempt|answer|choose|select)\s+(?:one|1)\b/iu.test(text) || /\bone\s+of\b/iu.test(text)) return 1;
  const numeric = text.match(/\b(?:any|attempt|answer|choose|select)\s+(\d{1,2})\b/iu);
  return numeric?.[1] ? Number(numeric[1]) : null;
}

function canonicalQuestionNumber(value: string) {
  const trimmed = value.trim();
  return /^\d+$/u.test(trimmed) ? String(Number(trimmed)) : trimmed;
}

function duplicates(values: string[]) {
  const seen = new Set<string>(); const duplicate = new Set<string>();
  for (const value of values.map(canonicalQuestionNumber)) { if (seen.has(value)) duplicate.add(value); seen.add(value); }
  return [...duplicate];
}

function unique<T>(values: T[]) { return [...new Set(values)]; }
function uniqueStrings(values: string[]) { return [...new Set(values.map((value) => value.trim()).filter(Boolean))]; }
function uniqueNumbers(values: number[]) { return [...new Set(values)].sort((left, right) => left - right); }
function sortedQuestionNumbers(values: string[]) { return [...values].sort(compareQuestionNumbers); }
function compareQuestionNumbers(left: string, right: string) { const leftNumber = /^\d+$/u.test(left) ? Number(left) : Number.NaN; const rightNumber = /^\d+$/u.test(right) ? Number(right) : Number.NaN; if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber; if (Number.isFinite(leftNumber)) return -1; if (Number.isFinite(rightNumber)) return 1; return left.localeCompare(right, undefined, { numeric: true }); }
function sortedNumbers(values: number[]) { return [...new Set(values)].sort((left, right) => left - right); }
function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }
