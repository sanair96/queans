"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, CopyCheck, Save, X } from "lucide-react";

const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

interface ReviewItem {
  id: string;
  reviewType: string;
  severity: string;
  reasonCodes: unknown;
  status: string;
  createdAt: string;
  reviewPayload: unknown;
  sourcePaper: {
    sourceFileName: string;
  };
  candidate: {
    id: string;
    questionNumber: string | null;
    questionType: string;
    rawOcrText: string;
    cleanedQuestionText: string;
    answerText: string | null;
    solutionText: string | null;
    difficulty: string | null;
    marks: number | null;
    overallConfidence: number;
    fieldConfidence: unknown;
    sourceEvidence: unknown;
  };
}

interface ReviewWorkbenchProps {
  initialItems: ReviewItem[];
}

interface ReviewDraft {
  cleanedQuestionText: string;
  answerText: string;
  solutionText: string;
  marks: string;
  difficulty: string;
  reviewNotes: string;
}

type ReviewDecision = "APPROVE" | "EDIT_AND_APPROVE" | "REJECT" | "MARK_DUPLICATE" | "MARK_UNPROCESSABLE";

export function ReviewWorkbench({ initialItems }: ReviewWorkbenchProps) {
  const [items, setItems] = useState(initialItems);
  const [selectedId, setSelectedId] = useState(initialItems[0]?.id ?? "");
  const selected = useMemo(() => items.find((item) => item.id === selectedId) ?? items[0], [items, selectedId]);
  const [draft, setDraft] = useState<ReviewDraft>(() => draftFromItem(selected));
  const [busyDecision, setBusyDecision] = useState<ReviewDecision | null>(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
    setDraft(draftFromItem(selected));
  }, [selected]);

  async function submitDecision(decision: ReviewDecision) {
    if (!selected) {
      return;
    }

    setBusyDecision(decision);
    setStatus("");
    try {
      const response = await fetch(`${apiBaseUrl}/api/review/tasks/${selected.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reviewPatchBody(selected, draft, decision))
      });

      if (!response.ok) {
        throw new Error(`Review update failed with ${response.status}`);
      }

      const remaining = items.filter((item) => item.id !== selected.id);
      setItems(remaining);
      setSelectedId(remaining[0]?.id ?? "");
      setStatus("Saved.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Review update failed.");
    } finally {
      setBusyDecision(null);
    }
  }

  if (!selected) {
    return (
      <section className="panel empty-state">
        <CopyCheck size={28} aria-hidden="true" />
        <strong>No open review items.</strong>
      </section>
    );
  }

  return (
    <section className="review-workbench">
      <div className="review-queue panel flat">
        <div className="queue-head">
          <strong>{items.length} open</strong>
          <span className="muted">Newest evidence first</span>
        </div>
        <div className="queue-list">
          {items.map((item) => (
            <button
              key={item.id}
              className={`queue-item ${item.id === selected.id ? "active" : ""}`}
              type="button"
              onClick={() => setSelectedId(item.id)}
            >
              <span className={`badge ${item.severity.toLowerCase()}`}>{item.severity}</span>
              <span className="queue-title">{item.candidate.cleanedQuestionText}</span>
              <span className="queue-meta">
                {item.reviewType} · {Math.round(item.candidate.overallConfidence * 100)}%
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="review-detail panel">
        <div className="review-title-row">
          <div>
            <p className="eyebrow">{selected.sourcePaper.sourceFileName}</p>
            <h2>{selected.candidate.questionNumber ? `Question ${selected.candidate.questionNumber}` : "Question candidate"}</h2>
          </div>
          <div className="button-row">
            <button
              className="btn secondary"
              type="button"
              title="Mark duplicate"
              disabled={busyDecision !== null}
              onClick={() => void submitDecision("MARK_DUPLICATE")}
            >
              <CopyCheck size={17} aria-hidden="true" />
              Duplicate
            </button>
            <button
              className="btn secondary"
              type="button"
              title="Reject"
              disabled={busyDecision !== null}
              onClick={() => void submitDecision("REJECT")}
            >
              <X size={17} aria-hidden="true" />
              Reject
            </button>
            <button
              className="btn secondary"
              type="button"
              title="Save edits and approve"
              disabled={busyDecision !== null}
              onClick={() => void submitDecision("EDIT_AND_APPROVE")}
            >
              <Save size={17} aria-hidden="true" />
              Save edits
            </button>
            <button
              className="btn"
              type="button"
              title="Approve"
              disabled={busyDecision !== null}
              onClick={() => void submitDecision("APPROVE")}
            >
              <Check size={17} aria-hidden="true" />
              Approve
            </button>
          </div>
        </div>

        <div className="review-metrics">
          <span className={`badge ${selected.severity.toLowerCase()}`}>{selected.severity}</span>
          <span>{selected.candidate.questionType}</span>
          <span>{selected.candidate.marks ?? "-"} marks</span>
          <span>{Math.round(selected.candidate.overallConfidence * 100)}% confidence</span>
        </div>

        <div className="reason-row">
          {formatReasons(selected.reasonCodes).map((reason) => (
            <code key={reason}>{reason}</code>
          ))}
        </div>

        <div className="review-columns">
          <div className="evidence-pane">
            <h3>Source OCR</h3>
            <pre>{selected.candidate.rawOcrText}</pre>
            <h3>Evidence</h3>
            <pre>{stableJson(selected.candidate.sourceEvidence)}</pre>
            <h3>Review context</h3>
            <pre>{stableJson(selected.reviewPayload)}</pre>
          </div>

          <form className="edit-pane">
            <label>
              Question
              <textarea
                value={draft.cleanedQuestionText}
                onChange={(event) => setDraft((current) => ({ ...current, cleanedQuestionText: event.target.value }))}
              />
            </label>
            <label>
              Answer
              <textarea
                value={draft.answerText}
                onChange={(event) => setDraft((current) => ({ ...current, answerText: event.target.value }))}
              />
            </label>
            <label>
              Solution
              <textarea
                value={draft.solutionText}
                onChange={(event) => setDraft((current) => ({ ...current, solutionText: event.target.value }))}
              />
            </label>
            <label>
              Marks
              <input
                value={draft.marks}
                inputMode="decimal"
                onChange={(event) => setDraft((current) => ({ ...current, marks: event.target.value }))}
              />
            </label>
            <label>
              Difficulty
              <input
                value={draft.difficulty}
                onChange={(event) => setDraft((current) => ({ ...current, difficulty: event.target.value }))}
              />
            </label>
            <label>
              Notes
              <textarea
                value={draft.reviewNotes}
                onChange={(event) => setDraft((current) => ({ ...current, reviewNotes: event.target.value }))}
              />
            </label>
          </form>
        </div>

        {status ? <div className="status compact">{status}</div> : null}
      </div>
    </section>
  );
}

function draftFromItem(item: ReviewItem | undefined): ReviewDraft {
  return {
    cleanedQuestionText: item?.candidate.cleanedQuestionText ?? "",
    answerText: item?.candidate.answerText ?? "",
    solutionText: item?.candidate.solutionText ?? "",
    marks: item?.candidate.marks === null || item?.candidate.marks === undefined ? "" : String(item.candidate.marks),
    difficulty: item?.candidate.difficulty ?? "",
    reviewNotes: ""
  };
}

function reviewPatchBody(item: ReviewItem, draft: ReviewDraft, decision: ReviewDecision) {
  const corrections = decision === "EDIT_AND_APPROVE" ? correctionsFromDraft(item, draft) : undefined;
  const reviewPayload =
    decision === "EDIT_AND_APPROVE"
      ? {
          candidate: {
            cleanedQuestionText: draft.cleanedQuestionText,
            answerText: draft.answerText,
            solutionText: draft.solutionText,
            marks: parseMarksDraft(draft.marks),
            difficulty: draft.difficulty
          }
        }
      : undefined;

  return {
    decision,
    reviewedBy: "local-reviewer",
    reviewNotes: draft.reviewNotes || undefined,
    reviewPayload,
    corrections
  };
}

function correctionsFromDraft(item: ReviewItem, draft: ReviewDraft) {
  return [
    correction("cleanedQuestionText", item.candidate.cleanedQuestionText, draft.cleanedQuestionText, "OCR_ERROR"),
    correction("answerText", item.candidate.answerText ?? "", draft.answerText, "WRONG_ANSWER"),
    correction("solutionText", item.candidate.solutionText ?? "", draft.solutionText, "BAD_SOLUTION"),
    correction("marks", item.candidate.marks === null ? "" : String(item.candidate.marks), draft.marks, "WRONG_MARKS"),
    correction("difficulty", item.candidate.difficulty ?? "", draft.difficulty, "FORMATTING_ISSUE")
  ].filter((value): value is NonNullable<typeof value> => value !== undefined);
}

function correction(fieldName: string, oldValue: string, newValue: string, correctionType: string) {
  if (oldValue === newValue) {
    return undefined;
  }

  return {
    fieldName,
    oldValue,
    newValue,
    correctionType
  };
}

function parseMarksDraft(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const marks = Number(trimmed);
  if (!Number.isFinite(marks) || marks < 0) {
    throw new Error("Marks must be a non-negative number.");
  }

  return marks;
}

function formatReasons(value: unknown) {
  if (!Array.isArray(value)) {
    return ["REVIEW_REQUIRED"];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function stableJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}
