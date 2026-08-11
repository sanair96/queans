"use client";

import type { BlueprintJsonValue } from "./blueprint-json-editor";

interface MarkingSchemeReviewFormProps {
  value: BlueprintJsonValue;
  onChange: (value: BlueprintJsonValue) => void;
  disabled?: boolean;
}

type JsonRecord = Record<string, BlueprintJsonValue>;

export function MarkingSchemeReviewForm({ value, onChange, disabled = false }: MarkingSchemeReviewFormProps) {
  if (!isMarkingScheme(value)) return null;
  const root = value;
  const update = (key: string, next: BlueprintJsonValue) => onChange({ ...root, [key]: next });
  const metadata = object(root.document_metadata);
  const blueprint = object(root.assessment_blueprint);
  const rules = array(root.evaluation_rules);
  const questions = array(root.question_marking_scheme);

  return (
    <div className="marking-review-form">
      <section className="marking-review-section">
        <div className="marking-review-heading"><span>01</span><div><p className="eyebrow">Document identity</p><h3>Paper details</h3></div></div>
        <div className="marking-field-grid">
          {([['title', 'Title'], ['subject', 'Subject'], ['examination', 'Examination'], ['paper_code', 'Paper code'], ['session', 'Session'], ['total_marks', 'Total marks']] as Array<[string, string]>).map(([key, label]) => (
            <Field key={key} label={label} value={metadata[key]} disabled={disabled} numeric={key === "total_marks"} onChange={(next) => update("document_metadata", { ...metadata, [key]: next })} />
          ))}
        </div>
      </section>

      <section className="marking-review-section">
        <div className="marking-review-heading"><span>02</span><div><p className="eyebrow">Evaluator guidance</p><h3>Marking rules</h3></div></div>
        <div className="marking-list">
          {rules.map((entry, index) => {
            const rule = object(entry);
            return <textarea aria-label={`Evaluator rule ${index + 1}`} className="marking-textarea" disabled={disabled} key={index} value={string(rule.rule)} onChange={(event) => update("evaluation_rules", rules.map((item, itemIndex) => itemIndex === index ? { ...rule, rule: event.target.value } : item))} />;
          })}
        </div>
      </section>

      <section className="marking-review-section">
        <div className="marking-review-heading"><span>03</span><div><p className="eyebrow">Assessment shape</p><h3>Sections and totals</h3></div></div>
        <div className="marking-section-list">
          {array(blueprint.sections).map((entry, index) => {
            const section = object(entry);
            return <div className="marking-section-card" key={index}>
              <Field label="Section" value={section.name} disabled={disabled} onChange={(next) => updateBlueprintSection(root, blueprint, index, { ...section, name: next }, onChange)} />
              <Field label="Question range" value={section.question_range} disabled={disabled} onChange={(next) => updateBlueprintSection(root, blueprint, index, { ...section, question_range: next }, onChange)} />
              <Field label="Declared marks" value={section.declared_marks} numeric disabled={disabled} onChange={(next) => updateBlueprintSection(root, blueprint, index, { ...section, declared_marks: next }, onChange)} />
            </div>;
          })}
        </div>
      </section>

      <section className="marking-review-section">
        <div className="marking-review-heading"><span>04</span><div><p className="eyebrow">Question-wise scheme</p><h3>{questions.length} extracted questions</h3></div></div>
        <div className="marking-question-list">
          {questions.map((entry, index) => <QuestionCard disabled={disabled} key={index} question={object(entry)} index={index} root={root} questions={questions} onChange={onChange} />)}
        </div>
      </section>
    </div>
  );
}

function QuestionCard({ question, index, questions, root, onChange, disabled }: { question: JsonRecord; index: number; questions: BlueprintJsonValue[]; root: JsonRecord; onChange: (value: BlueprintJsonValue) => void; disabled: boolean }) {
  const updateQuestion = (next: JsonRecord) => onChange({ ...root, question_marking_scheme: questions.map((item, itemIndex) => itemIndex === index ? next : item) });
  return <article className="marking-question-card">
    <div className="marking-question-top"><strong>Question {string(question.number) || index + 1}</strong><span className="marking-source">Pages {array(question.source_pages).join(", ") || "—"}</span></div>
    <div className="marking-field-grid compact">
      <Field label="Number" value={question.number} disabled={disabled} onChange={(next) => updateQuestion({ ...question, number: next })} />
      <Field label="Section" value={question.section} disabled={disabled} onChange={(next) => updateQuestion({ ...question, section: next })} />
      <Field label="Marks" value={question.marks} numeric disabled={disabled} onChange={(next) => updateQuestion({ ...question, marks: next })} />
    </div>
    <TextList label="Value points" value={array(question.value_points)} disabled={disabled} onChange={(next) => updateQuestion({ ...question, value_points: next })} />
    <TextList label="Acceptable answers" value={array(question.acceptable_answers)} disabled={disabled} onChange={(next) => updateQuestion({ ...question, acceptable_answers: next })} />
    <TextList label="Marking notes" value={array(question.marking_notes)} disabled={disabled} onChange={(next) => updateQuestion({ ...question, marking_notes: next })} />
    {(array(question.parts).length > 0 || array(question.alternatives).length > 0) ? <details className="marking-details"><summary>Parts and alternatives</summary><p>{array(question.parts).length} parts · {array(question.alternatives).length} alternatives. These are retained with the question and source pages.</p></details> : null}
  </article>;
}

function TextList({ label, value, onChange, disabled }: { label: string; value: BlueprintJsonValue[]; onChange: (value: BlueprintJsonValue[]) => void; disabled: boolean }) {
  return <label className="marking-list-field"><span>{label}</span><textarea disabled={disabled} value={value.map(string).join("\n")} onChange={(event) => onChange(event.target.value.split("\n").map((line) => line.trim()).filter(Boolean))} /></label>;
}

function Field({ label, value, onChange, disabled, numeric = false }: { label: string; value: BlueprintJsonValue | undefined; onChange: (value: BlueprintJsonValue) => void; disabled: boolean; numeric?: boolean }) {
  const displayed = value === null || value === undefined ? "" : String(value);
  return <label className="marking-field"><span>{label}</span><input disabled={disabled} inputMode={numeric ? "decimal" : undefined} type={numeric ? "number" : "text"} value={displayed} onChange={(event) => onChange(numeric ? (event.target.value === "" ? null : Number(event.target.value)) : (event.target.value || null))} /></label>;
}

function updateBlueprintSection(root: JsonRecord, blueprint: JsonRecord, index: number, nextSection: JsonRecord, onChange: (value: BlueprintJsonValue) => void) {
  const sections = array(blueprint.sections).map((item, itemIndex) => itemIndex === index ? nextSection : item);
  onChange({ ...root, assessment_blueprint: { ...blueprint, sections } });
}

function isMarkingScheme(value: BlueprintJsonValue): value is JsonRecord { return isRecord(value) && isRecord(value.document_metadata) && Array.isArray(value.evaluation_rules) && isRecord(value.assessment_blueprint) && Array.isArray(value.question_marking_scheme); }
function isRecord(value: BlueprintJsonValue | undefined): value is JsonRecord { return typeof value === "object" && value !== null && !Array.isArray(value); }
function object(value: BlueprintJsonValue | undefined): JsonRecord { return isRecord(value) ? value : {}; }
function array(value: BlueprintJsonValue | undefined): BlueprintJsonValue[] { return Array.isArray(value) ? value : []; }
function string(value: BlueprintJsonValue | undefined): string { return typeof value === "string" || typeof value === "number" ? String(value) : ""; }
