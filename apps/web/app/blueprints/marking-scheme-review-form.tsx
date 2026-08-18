"use client";

import type { BlueprintJsonValue } from "./blueprint-json-editor";

interface MarkingSchemeReviewFormProps {
  value: BlueprintJsonValue;
  onChange: (value: BlueprintJsonValue) => void;
  disabled?: boolean;
}

type JsonRecord = Record<string, BlueprintJsonValue>;

export function formatQuestionRangeForDisplay(value: string | null | undefined) {
  if (!value) return "";
  const normalized = value.replace(/[–—]/gu, "-").trim();
  const tokens = normalized.split(",").map((token) => token.trim()).filter(Boolean);
  if (tokens.length === 0 || !tokens.every((token) => /^\d+(?:\s*-\s*\d+)?$/u.test(token))) return value;

  const ranges = tokens.map((token) => {
    const range = token.split("-");
    const start = Number(range[0]!.trim());
    const end = range[1] === undefined ? start : Number(range[1].trim());
    return { start, end };
  });
  if (ranges.some(({ start, end }) => end < start)) return value;
  const numbers = ranges.flatMap(({ start, end }) => {
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  });
  const uniqueNumbers = [...new Set(numbers)].sort((left, right) => left - right);
  if (uniqueNumbers.length < 2 || uniqueNumbers.some((number, index) => index > 0 && number !== uniqueNumbers[index - 1]! + 1)) return value;
  return `${uniqueNumbers[0]}–${uniqueNumbers.at(-1)}`;
}

export function groupQuestionIndexForReview(entries: BlueprintJsonValue[]) {
  const groups = new Map<string, JsonRecord>();
  const childLabels = new Map<string, { parts: string[]; alternatives: string[] }>();

  for (const entry of entries) {
    const question = object(entry);
    const identity = questionIdentity(question.number);
    if (!identity) continue;
    const existing = groups.get(identity.parentNumber);
    if (identity.isChild) {
      const labels = childLabels.get(identity.parentNumber) ?? { parts: [], alternatives: [] };
      if (identity.label) labels.parts.push(identity.label);
      labels.parts.push(...array(question.part_labels).map(string));
      labels.alternatives.push(...array(question.alternative_labels).map(string));
      childLabels.set(identity.parentNumber, labels);
    }

    const merged = existing
      ? identity.isChild ? mergeQuestionRecords(existing, question) : mergeQuestionRecords(question, existing)
      : { ...question, number: identity.parentNumber };
    groups.set(identity.parentNumber, { ...merged, number: identity.parentNumber });
  }

  for (const [number, labels] of childLabels) {
    const question = groups.get(number);
    if (!question) continue;
    groups.set(number, {
      ...question,
      part_labels: uniqueStrings([...array(question.part_labels).map(string), ...labels.parts]),
      alternative_labels: uniqueStrings([...array(question.alternative_labels).map(string), ...labels.alternatives])
    });
  }

  return [...groups.values()];
}

export function MarkingSchemeReviewForm({ value, onChange, disabled = false }: MarkingSchemeReviewFormProps) {
  if (!isStructuralBlueprint(value)) return null;
  const root = value;
  const update = (key: string, next: BlueprintJsonValue) => onChange({ ...root, [key]: next });
  const metadata = object(root.document_metadata);
  const blueprint = object(root.assessment_blueprint);
  const rules = array(root.evaluation_rules);
  const questions = groupQuestionIndexForReview(array(root.question_index));

  return (
    <div className="marking-review-form">
      <section className="marking-review-section">
        <div className="marking-review-heading"><span>01</span><div><p className="eyebrow">Paper details</p><h3>About this Blueprint</h3></div></div>
        <div className="marking-field-grid">
          {([['title', 'Title'], ['subject', 'Subject'], ['examination', 'Examination'], ['paper_code', 'Paper code'], ['session', 'Session'], ['total_marks', 'Total marks']] as Array<[string, string]>).map(([key, label]) => (
            <Field key={key} label={label} value={metadata[key]} disabled={disabled} numeric={key === "total_marks"} onChange={(next) => update("document_metadata", { ...metadata, [key]: next })} />
          ))}
        </div>
      </section>

      <section className="marking-review-section">
        <div className="marking-review-heading"><span>02</span><div><p className="eyebrow">Instructions</p><h3>Guidance for marking</h3></div></div>
        <div className="marking-list">
          {rules.map((entry, index) => {
            const rule = object(entry);
            return <textarea aria-label={`Evaluator rule ${index + 1}`} className="marking-textarea" disabled={disabled} key={index} value={string(rule.rule)} onChange={(event) => update("evaluation_rules", rules.map((item, itemIndex) => itemIndex === index ? { ...rule, rule: event.target.value } : item))} />;
          })}
        </div>
      </section>

      <section className="marking-review-section">
        <div className="marking-review-heading"><span>03</span><div><p className="eyebrow">Assessment sections</p><h3>Sections and totals</h3></div></div>
        <div className="marking-section-list">
          {array(blueprint.sections).map((entry, index) => {
            const section = object(entry);
            return <div className="marking-section-card" key={index}>
              <Field label="Section" value={section.name} disabled={disabled} onChange={(next) => updateBlueprintSection(root, blueprint, index, { ...section, name: next }, onChange)} />
              <Field label="Questions in this section" value={formatQuestionRangeForDisplay(stringOrNull(section.question_range))} disabled={disabled} onChange={(next) => updateBlueprintSection(root, blueprint, index, { ...section, question_range: next }, onChange)} />
              <Field label="Question type" value={section.question_type} disabled={disabled} onChange={(next) => updateBlueprintSection(root, blueprint, index, { ...section, question_type: next }, onChange)} />
              <Field label="Declared marks" value={section.declared_marks} numeric disabled={disabled} onChange={(next) => updateBlueprintSection(root, blueprint, index, { ...section, declared_marks: next }, onChange)} />
              <ReadOnlyValue label="Choice rules" value={array(section.choice_rules).map(string).join("; ") || "—"} />
              <ReadOnlyValue label="Source pages" value={pages(section.source_pages)} />
            </div>;
          })}
        </div>
      </section>

      <section className="marking-review-section">
        <div className="marking-review-heading"><span>04</span><div><p className="eyebrow">Question groups</p><h3>{questions.length} top-level questions</h3></div></div>
        <div className="marking-question-list">
          {questions.map((entry, index) => <QuestionCard disabled={disabled} key={index} question={object(entry)} index={index} root={root} questions={questions} onChange={onChange} />)}
        </div>
      </section>
    </div>
  );
}

function QuestionCard({ question, index, questions, root, onChange, disabled }: { question: JsonRecord; index: number; questions: BlueprintJsonValue[]; root: JsonRecord; onChange: (value: BlueprintJsonValue) => void; disabled: boolean }) {
  const updateQuestion = (next: JsonRecord) => onChange({ ...root, question_index: questions.map((item, itemIndex) => itemIndex === index ? next : item) });
  return <article className="marking-question-card">
    <div className="marking-question-top"><strong>Question {string(question.number) || index + 1}</strong><span className="marking-source">Source pages {pages(question.source_pages)}</span></div>
    <div className="marking-field-grid compact">
      <Field label="Number" value={question.number} disabled={disabled} onChange={(next) => updateQuestion({ ...question, number: next })} />
      <Field label="Section" value={question.section} disabled={disabled} onChange={(next) => updateQuestion({ ...question, section: next })} />
      <Field label="Marks" value={question.marks} numeric disabled={disabled} onChange={(next) => updateQuestion({ ...question, marks: next })} />
      <Field label="Question type" value={question.question_type} disabled={disabled} onChange={(next) => updateQuestion({ ...question, question_type: next })} />
    </div>
    <div className="marking-structural-summary">
      <ReadOnlyValue label="Parts" value={array(question.part_labels).map(string).join(", ") || "None detected"} />
      <ReadOnlyValue label="Alternative choices" value={array(question.alternative_labels).map(string).join(", ") || "None detected"} />
    </div>
  </article>;
}

function Field({ label, value, onChange, disabled, numeric = false }: { label: string; value: BlueprintJsonValue | undefined; onChange: (value: BlueprintJsonValue) => void; disabled: boolean; numeric?: boolean }) {
  const displayed = value === null || value === undefined ? "" : typeof value === "string" || typeof value === "number" ? String(value) : "";
  return <label className="marking-field"><span>{label}</span><input disabled={disabled} inputMode={numeric ? "decimal" : undefined} type={numeric ? "number" : "text"} value={displayed} onChange={(event) => onChange(numeric ? (event.target.value === "" ? null : Number(event.target.value)) : (event.target.value || null))} /></label>;
}

function ReadOnlyValue({ label, value }: { label: string; value: string }) {
  return <div className="marking-field"><span>{label}</span><output>{value}</output></div>;
}

function updateBlueprintSection(root: JsonRecord, blueprint: JsonRecord, index: number, nextSection: JsonRecord, onChange: (value: BlueprintJsonValue) => void) {
  const sections = array(blueprint.sections).map((item, itemIndex) => itemIndex === index ? nextSection : item);
  onChange({ ...root, assessment_blueprint: { ...blueprint, sections } });
}

function isStructuralBlueprint(value: BlueprintJsonValue): value is JsonRecord { return isRecord(value) && isRecord(value.document_metadata) && Array.isArray(value.evaluation_rules) && isRecord(value.assessment_blueprint) && Array.isArray(value.question_index); }
function isRecord(value: BlueprintJsonValue | undefined): value is JsonRecord { return typeof value === "object" && value !== null && !Array.isArray(value); }
function object(value: BlueprintJsonValue | undefined): JsonRecord { return isRecord(value) ? value : {}; }
function array(value: BlueprintJsonValue | undefined): BlueprintJsonValue[] { return Array.isArray(value) ? value : []; }
function string(value: BlueprintJsonValue | undefined): string { return typeof value === "string" || typeof value === "number" ? String(value) : ""; }
function stringOrNull(value: BlueprintJsonValue | undefined): string | null { return typeof value === "string" ? value : null; }
function pages(value: BlueprintJsonValue | undefined): string { return array(value).map(string).join(", ") || "—"; }

function questionIdentity(value: BlueprintJsonValue | undefined) {
  const label = string(value).trim().replace(/^(?:question|ques|q)\s*/iu, "");
  const match = label.match(/^(\d+)(.*)$/u);
  if (!match) return label ? { parentNumber: label, isChild: false, label: null } : null;
  const suffix = match[2]!.replace(/[.()[\]{}\s]/gu, "").toLowerCase();
  return { parentNumber: String(Number(match[1])), isChild: suffix.length > 0, label: suffix || null };
}

function mergeQuestionRecords(left: JsonRecord, right: JsonRecord) {
  return {
    ...left,
    section: left.section ?? right.section ?? null,
    marks: left.marks ?? right.marks ?? null,
    question_type: left.question_type ?? right.question_type ?? null,
    part_labels: uniqueStrings([...array(left.part_labels).map(string), ...array(right.part_labels).map(string)]),
    alternative_labels: uniqueStrings([...array(left.alternative_labels).map(string), ...array(right.alternative_labels).map(string)]),
    source_pages: uniqueNumbers([...array(left.source_pages).map(Number), ...array(right.source_pages).map(Number)])
  };
}

function uniqueStrings(values: string[]) { return [...new Set(values.map((value) => value.trim()).filter(Boolean))]; }
function uniqueNumbers(values: number[]) { return [...new Set(values.filter((value) => Number.isFinite(value)))].sort((left, right) => left - right); }
