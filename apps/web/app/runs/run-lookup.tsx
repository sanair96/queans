"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Search } from "lucide-react";

import { assertOk } from "../api-errors";

const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

interface IngestionRun {
  id: string;
  status: string;
  currentStep: string | null;
  sourcePaperId: string | null;
  outputPayload: unknown;
  errorPayload: unknown;
  counts?: {
    questionCandidates: number;
    reviewItems: number;
    ocrPages: number;
  };
  steps: Array<{
    id: string;
    stepName: string;
    status: string;
    attemptCount: number;
    startedAt: string | null;
    completedAt: string | null;
    errorPayload: unknown;
    outputPayload: unknown;
  }>;
  events: Array<{
    id: string;
    eventType: string;
    eventPayload: unknown;
    createdAt: string;
  }>;
  costs: Array<{
    id: string;
    provider: string;
    model: string;
    operation: string;
    pageCount: number | null;
    inputTokenCount: number | null;
    outputTokenCount: number | null;
    estimatedCostUsd: string | null;
  }>;
}

export function RunLookup() {
  const searchParams = useSearchParams();
  const initialRunId = searchParams.get("run") ?? "";
  const [runId, setRunId] = useState(initialRunId);
  const [run, setRun] = useState<IngestionRun | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (initialRunId) {
      void loadRun(initialRunId);
    }
  }, [initialRunId]);

  async function loadRun(id = runId) {
    const trimmed = id.trim();
    if (!trimmed) {
      setStatus("Enter a run ID.");
      return;
    }

    setBusy(true);
    setStatus("");
    try {
      const response = await fetch(`${apiBaseUrl}/api/ingestions/${trimmed}`, {
        cache: "no-store"
      });
      await assertOk(response, "Run lookup");
      setRun((await response.json()) as IngestionRun);
    } catch (error) {
      setRun(null);
      setStatus(error instanceof Error ? error.message : "Run lookup failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="run-lookup">
      <div className="panel flat">
        <div className="lookup-form">
          <input value={runId} onChange={(event) => setRunId(event.target.value)} placeholder="ingestion run id" />
          <button className="btn" type="button" disabled={busy} onClick={() => void loadRun()}>
            <Search size={17} aria-hidden="true" />
            {busy ? "Loading" : "Lookup"}
          </button>
        </div>
        {status ? <div className="status compact">{status}</div> : null}
      </div>

      {run ? (
        <>
          <section className="panel run-summary">
            <div>
              <p className="eyebrow">Status</p>
              <h2>{run.status}</h2>
              <span className="muted">{run.currentStep ?? "No active step"}</span>
            </div>
            <div className="stat-row compact">
              <div className="stat">
                <span>OCR pages</span>
                <strong>{run.counts?.ocrPages ?? 0}</strong>
              </div>
              <div className="stat">
                <span>Candidates</span>
                <strong>{run.counts?.questionCandidates ?? 0}</strong>
              </div>
              <div className="stat">
                <span>Review</span>
                <strong>{run.counts?.reviewItems ?? 0}</strong>
              </div>
            </div>
          </section>

          <div className="run-columns">
            <section className="panel">
              <h2>Steps</h2>
              <div className="step-list">
                {run.steps.map((step) => (
                  <div className="step-row" key={step.id}>
                    <span className={`step-dot ${step.status.toLowerCase()}`} />
                    <div>
                      <strong>{step.stepName}</strong>
                      <span className="muted">
                        {step.status} · attempt {step.attemptCount}
                      </span>
                    </div>
                  </div>
                ))}
                {run.steps.length === 0 ? <p className="muted">No steps recorded.</p> : null}
              </div>
            </section>

            <section className="panel">
              <h2>Events</h2>
              <div className="event-log">
                {run.events.map((event) => (
                  <details key={event.id}>
                    <summary>
                      <strong>{event.eventType}</strong>
                      <span>{new Date(event.createdAt).toLocaleString()}</span>
                    </summary>
                    <pre>{stableJson(event.eventPayload)}</pre>
                  </details>
                ))}
                {run.events.length === 0 ? <p className="muted">No events recorded.</p> : null}
              </div>
            </section>
          </div>

          {hasPayload(run.outputPayload) || hasPayload(run.errorPayload) ? (
            <section className="panel">
              <h2>{hasPayload(run.errorPayload) ? "Failure output" : "Run output"}</h2>
              <pre className="json-block">{stableJson(hasPayload(run.errorPayload) ? run.errorPayload : run.outputPayload)}</pre>
            </section>
          ) : null}

          <section className="panel">
            <h2>Provider usage</h2>
            <table className="table">
              <thead>
                <tr>
                  <th>Operation</th>
                  <th>Provider</th>
                  <th>Model</th>
                  <th>Pages</th>
                  <th>Input</th>
                  <th>Output</th>
                </tr>
              </thead>
              <tbody>
                {run.costs.map((cost) => (
                  <tr key={cost.id}>
                    <td>{cost.operation}</td>
                    <td>{cost.provider}</td>
                    <td>{cost.model}</td>
                    <td>{cost.pageCount ?? "-"}</td>
                    <td>{cost.inputTokenCount ?? "-"}</td>
                    <td>{cost.outputTokenCount ?? "-"}</td>
                  </tr>
                ))}
                {run.costs.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="muted">
                      No provider usage recorded.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </section>
        </>
      ) : null}
    </section>
  );
}

function stableJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function hasPayload(value: unknown) {
  return value !== null && value !== undefined;
}
