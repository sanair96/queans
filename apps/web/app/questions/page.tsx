import { apiGet } from "../api-client";

interface Question {
  id: string;
  questionText: string;
  questionType: string;
  marks: number | null;
  options: unknown;
  parentQuestionNumber: string | null;
  questionLabel: string | null;
  partLabel: string | null;
  groupKey: string | null;
  stemText: string | null;
  displayOrder: number | null;
  requiresDiagram: boolean;
  diagramAsset: unknown;
  sourceEvidence: unknown;
  answers: Array<{ answerText: string; solutionText: string | null; sourceType: string; reviewStatus: string }>;
  chapter: { name: string } | null;
  topic: { name: string } | null;
  subtopic: { name: string } | null;
  sourcePaper: { id?: string; sourceFileName: string; title: string | null } | null;
}

interface QuestionGroup {
  key: string;
  label: string;
  stemText: string | null;
  sourcePaper: Question["sourcePaper"];
  questions: Question[];
}

interface DiagramImage {
  url: string;
  label: string;
}

export default async function QuestionsPage() {
  const data = await loadQuestions();
  const groups = groupQuestions(data.questions);

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">Question bank</p>
          <h1>Approved questions</h1>
          <p className="muted">Only approved or edited-and-approved candidates are committed here.</p>
        </div>
      </header>
      <section className="panel question-bank">
        {data.error ? <p className="muted">{data.error}</p> : null}
        {!data.error && groups.length === 0 ? <p className="muted">No approved questions yet.</p> : null}
        {!data.error
          ? groups.map((group) => (
              <article className="question-group" key={group.key}>
                <div className="question-group-head">
                  <div>
                    <p className="eyebrow">{group.label}</p>
                    {group.stemText ? <h2>{group.stemText}</h2> : null}
                    {group.sourcePaper ? (
                      <p className="muted">{group.sourcePaper.title ?? group.sourcePaper.sourceFileName}</p>
                    ) : null}
                  </div>
                  <span className="badge">{group.questions.length > 1 ? `${group.questions.length} parts` : "Single"}</span>
                </div>
                <div className="question-list">
                  {group.questions.map((question) => (
                    <QuestionItem key={question.id} question={question} />
                  ))}
                </div>
              </article>
            ))
          : null}
      </section>
    </>
  );
}

function QuestionItem({ question }: { question: Question }) {
  const images = diagramImagesFromAsset(question.diagramAsset);
  return (
    <section className="question-item">
      <div className="question-main">
        <div className="question-meta">
          {question.partLabel ? <span className="badge">{question.partLabel}</span> : null}
          <span className="badge">{question.questionType}</span>
          <span className="badge">{question.marks ?? "-"} marks</span>
          {question.topic ? <span className="badge">{question.topic.name}</span> : null}
        </div>
        <p className="question-text">{question.questionText}</p>
        {question.answers[0] ? (
          <div className="answer-block">
            <strong>Answer</strong>
            <p>{question.answers[0].answerText}</p>
            <span className="muted">
              {question.answers[0].sourceType} - {question.answers[0].reviewStatus}
            </span>
          </div>
        ) : null}
        {images.length > 0 ? (
          <div className="diagram-grid">
            {images.map((image) => (
              <figure key={image.url} className="diagram-figure">
                <img src={image.url} alt={image.label} />
                <figcaption>{image.label}</figcaption>
              </figure>
            ))}
          </div>
        ) : null}
      </div>
      <details className="source-details">
        <summary>Source context</summary>
        <pre>{stableJson(question.sourceEvidence)}</pre>
      </details>
    </section>
  );
}

export function groupQuestions(questions: Question[]): QuestionGroup[] {
  const groups = new Map<string, QuestionGroup>();
  for (const question of questions) {
    const key = questionGroupKey(question);
    const label = question.parentQuestionNumber ?? question.questionLabel ?? question.groupKey ?? "Question";
    const existing = groups.get(key);
    if (existing) {
      existing.questions.push(question);
      if (!existing.stemText && question.stemText) {
        existing.stemText = question.stemText;
      }
      continue;
    }

    groups.set(key, {
      key,
      label,
      stemText: question.stemText,
      sourcePaper: question.sourcePaper,
      questions: [question]
    });
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      questions: [...group.questions].sort(compareQuestions)
    }))
    .sort(compareGroups);
}

function questionGroupKey(question: Question) {
  if (question.parentQuestionNumber && (question.partLabel || question.stemText)) {
    return `parent:${question.sourcePaper?.id ?? question.sourcePaper?.sourceFileName ?? "unknown"}:${question.parentQuestionNumber}`;
  }
  return `question:${question.id}`;
}

function compareQuestions(a: Question, b: Question) {
  return (
    compareNullableNumbers(a.displayOrder, b.displayOrder) ||
    compareLabels(a.partLabel, b.partLabel) ||
    compareLabels(a.questionLabel, b.questionLabel) ||
    a.id.localeCompare(b.id)
  );
}

function compareGroups(a: QuestionGroup, b: QuestionGroup) {
  const firstA = a.questions[0];
  const firstB = b.questions[0];
  if (!firstA || !firstB) {
    return a.key.localeCompare(b.key);
  }

  return (
    compareLabels(firstA.sourcePaper?.sourceFileName ?? null, firstB.sourcePaper?.sourceFileName ?? null) ||
    compareNullableNumbers(firstA.displayOrder, firstB.displayOrder) ||
    compareLabels(firstA.parentQuestionNumber ?? firstA.questionLabel, firstB.parentQuestionNumber ?? firstB.questionLabel) ||
    a.key.localeCompare(b.key)
  );
}

function compareNullableNumbers(a: number | null, b: number | null) {
  return (a ?? Number.MAX_SAFE_INTEGER) - (b ?? Number.MAX_SAFE_INTEGER);
}

function compareLabels(a: string | null, b: string | null) {
  return labelOrder(a) - labelOrder(b) || (a ?? "").localeCompare(b ?? "");
}

function labelOrder(value: string | null) {
  if (!value) {
    return Number.MAX_SAFE_INTEGER;
  }
  const normalized = value.trim().toLowerCase().replace(/^[^\da-z]+|[^\da-z]+$/giu, "");
  const numeric = Number.parseInt(normalized, 10);
  if (Number.isFinite(numeric)) {
    return numeric;
  }
  const roman = romanNumeralOrder(normalized);
  if (roman !== undefined) {
    return roman;
  }
  if (/^[a-z]$/u.test(normalized)) {
    return normalized.charCodeAt(0) - "a".charCodeAt(0) + 1;
  }
  return Number.MAX_SAFE_INTEGER;
}

function romanNumeralOrder(value: string) {
  const romanValues: Record<string, number> = {
    i: 1,
    ii: 2,
    iii: 3,
    iv: 4,
    v: 5,
    vi: 6,
    vii: 7,
    viii: 8,
    ix: 9,
    x: 10
  };
  return romanValues[value];
}

function diagramImagesFromAsset(value: unknown): DiagramImage[] {
  if (Array.isArray(value)) {
    return value.flatMap(diagramImagesFromAsset);
  }
  if (!value || typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  const current =
    typeof record.url === "string"
      ? [
          {
            url: record.url,
            label: diagramLabel(record)
          }
        ]
      : [];
  return [...current, ...Object.values(record).flatMap(diagramImagesFromAsset)];
}

function diagramLabel(record: Record<string, unknown>) {
  for (const key of ["label", "fileName", "imageId", "description"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return "Question diagram";
}

function stableJson(value: unknown) {
  return JSON.stringify(value ?? {}, null, 2);
}

async function loadQuestions() {
  try {
    const data = await apiGet<{ questions: Question[] }>("/api/questions");
    return { questions: data.questions, error: undefined };
  } catch (error) {
    return {
      questions: [],
      error: error instanceof Error ? error.message : "Questions failed to load."
    };
  }
}
