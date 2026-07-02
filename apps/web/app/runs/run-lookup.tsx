"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, RefreshCw, Search } from "lucide-react";

import { assertOk } from "../api-errors";

const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

interface IngestionRun {
  id: string;
  status: string;
  currentStep: string | null;
  sourcePaperId: string | null;
  retryOfWorkflowRun?: RunLineageSummary | null;
  retryAttempts?: RunLineageSummary[];
  outputPayload: unknown;
  errorPayload: unknown;
  failureSummary?: WorkflowFailureSummary | null;
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
  providerBatchJobs: ProviderBatchJob[];
}

interface IngestionRunListItem {
  id: string;
  status: string;
  currentStep: string | null;
  createdAt: string;
  sourcePaperId: string | null;
  retryOfWorkflowRunId: string | null;
  sourcePaper: {
    id: string;
    title: string | null;
    sourceFileName: string;
    status: string;
  } | null;
  latestStep: {
    stepName: string;
    status: string;
  } | null;
  latestBatchJob: ProviderBatchJob | null;
  counts?: {
    questionCandidates: number;
    reviewItems: number;
    ocrPages: number;
  };
  estimatedCostUsd: string | null;
}

interface ProviderBatchJob {
  id: string;
  provider: string;
  operation: string;
  endpoint: string;
  model: string;
  status: string;
  inputFileId: string | null;
  providerJobId: string | null;
  outputFileId: string | null;
  errorFileId: string | null;
  totalRequests: number | null;
  succeededRequests: number | null;
  failedRequests: number | null;
  createdAt: string;
  updatedAt: string;
  importedAt: string | null;
  importError: unknown;
}

interface RunLineageSummary {
  id: string;
  status: string;
  currentStep: string | null;
  createdAt: string;
}

interface WorkflowFailureSummary {
  title: string;
  detail: string;
  failedStep?: string;
  failureType?: string;
  rootCause: string;
  provider?: string;
  model?: string;
  issues: WorkflowFailureIssue[];
}

interface WorkflowFailureIssue {
  path: Array<string | number>;
  field: string;
  message: string;
  code?: string;
  expected?: string;
  received?: string;
  candidateIndex?: number;
}

interface FailureDiagnosisProps {
  summary: WorkflowFailureSummary;
  payload: unknown;
}

export function RunLookup() {
  const searchParams = useSearchParams();
  const initialRunId = searchParams.get("run") ?? "";
  const [runId, setRunId] = useState(initialRunId);
  const [run, setRun] = useState<IngestionRun | null>(null);
  const [runs, setRuns] = useState<IngestionRunListItem[]>([]);
  const [filterStatus, setFilterStatus] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);

  useEffect(() => {
    void loadRuns();
    if (initialRunId) {
      void loadRun(initialRunId);
    }
  }, [initialRunId]);

  async function loadRuns() {
    const params = new URLSearchParams();
    if (filterStatus.trim()) {
      params.set("status", filterStatus.trim());
    }
    const response = await fetch(`${apiBaseUrl}/api/ingestions?${params.toString()}`, {
      cache: "no-store"
    });
    await assertOk(response, "Run history");
    const payload = (await response.json()) as { runs: IngestionRunListItem[] };
    setRuns(payload.runs);
  }

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
      setRunId(trimmed);
    } catch (error) {
      setRun(null);
      setStatus(error instanceof Error ? error.message : "Run lookup failed.");
    } finally {
      setBusy(false);
    }
  }

  async function retryRun(id: string) {
    setRetrying(`run:${id}`);
    setStatus("");
    try {
      const response = await fetch(`${apiBaseUrl}/api/ingestions/${id}/retry`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({})
      });
      await assertOk(response, "Retry run");
      const payload = (await response.json()) as { ingestionRunId: string };
      await loadRuns();
      await loadRun(payload.ingestionRunId);
      setStatus(`Retry queued: ${payload.ingestionRunId}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Retry failed.");
    } finally {
      setRetrying(null);
    }
  }

  async function retryBatchImport(id: string) {
    setRetrying(`batch:${id}`);
    setStatus("");
    try {
      const response = await fetch(`${apiBaseUrl}/api/provider-batch-jobs/${id}/retry-import`, {
        method: "POST"
      });
      await assertOk(response, "Retry batch import");
      const payload = (await response.json()) as { ingestionRunId: string };
      await loadRuns();
      await loadRun(payload.ingestionRunId);
      setStatus(`Batch import retry queued: ${payload.ingestionRunId}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Batch import retry failed.");
    } finally {
      setRetrying(null);
    }
  }

  const failureSummary = run ? failureSummaryForRun(run) : null;
  const totalEstimatedCost = run ? totalEstimatedCostUsd(run.costs) : null;

  return (
    <section className="run-lookup">
      <div className="panel flat">
        <div className="runs-toolbar">
          <select value={filterStatus} onChange={(event) => setFilterStatus(event.target.value)} aria-label="Filter status">
            <option value="">All statuses</option>
            <option value="PENDING">Pending</option>
            <option value="RUNNING">Running</option>
            <option value="WAITING_FOR_REVIEW">Waiting for review</option>
            <option value="FAILED">Failed</option>
            <option value="COMPLETED">Completed</option>
            <option value="CANCELLED">Cancelled</option>
          </select>
          <button className="btn secondary" type="button" onClick={() => void loadRuns()}>
            <RefreshCw size={16} aria-hidden="true" />
            Refresh
          </button>
        </div>
        <table className="table runs-table">
          <thead>
            <tr>
              <th>Run</th>
              <th>Source</th>
              <th>Status</th>
              <th>Batch</th>
              <th>Counts</th>
              <th>Cost</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((item) => (
              <tr key={item.id}>
                <td>
                  <button className="link-button" type="button" onClick={() => void loadRun(item.id)}>
                    {shortId(item.id)}
                  </button>
                  <span className="muted">{new Date(item.createdAt).toLocaleString()}</span>
                  {item.retryOfWorkflowRunId ? <span className="badge">Retry</span> : null}
                </td>
                <td>{item.sourcePaper?.sourceFileName ?? item.sourcePaperId ?? "-"}</td>
                <td>
                  <span className={`badge ${item.status.toLowerCase()}`}>{item.status}</span>
                  <span className="muted">{item.currentStep ?? item.latestStep?.stepName ?? "-"}</span>
                </td>
                <td>
                  {item.latestBatchJob ? (
                    <>
                      <strong>{item.latestBatchJob.operation}</strong>
                      <span className="muted">{item.latestBatchJob.status}</span>
                    </>
                  ) : (
                    "-"
                  )}
                </td>
                <td>
                  {item.counts
                    ? `${item.counts.ocrPages} pages, ${item.counts.questionCandidates} candidates, ${item.counts.reviewItems} review`
                    : "-"}
                </td>
                <td>{formatEstimatedCostUsd(item.estimatedCostUsd)}</td>
                <td>
                  <div className="row-actions">
                    <button className="btn secondary" type="button" onClick={() => void loadRun(item.id)}>
                      View
                    </button>
                    {isRunRetryable(item.status) ? (
                      <button
                        className="btn secondary"
                        type="button"
                        disabled={retrying !== null}
                        onClick={() => void retryRun(item.id)}
                      >
                        Retry
                      </button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
            {runs.length === 0 ? (
              <tr>
                <td colSpan={7} className="muted">
                  No ingestion runs found.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

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
          {failureSummary ? <FailureDiagnosis summary={failureSummary} payload={run.errorPayload} /> : null}

          <section className="panel run-summary">
            <div>
              <p className="eyebrow">Status</p>
              <h2>{run.status}</h2>
              <span className="muted">{run.currentStep ?? "No active step"}</span>
              {run.retryOfWorkflowRun ? (
                <button className="link-button" type="button" onClick={() => void loadRun(run.retryOfWorkflowRun?.id ?? "")}>
                  Retry of {shortId(run.retryOfWorkflowRun.id)}
                </button>
              ) : null}
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
              <div className="stat">
                <span>Cost</span>
                <strong>{formatEstimatedCostUsd(totalEstimatedCost)}</strong>
              </div>
            </div>
          </section>

          <div className="run-columns">
            <section className="panel">
              <h2>Steps</h2>
              <div className="step-list">
                {run.steps.map((step) => (
                  <div className={`step-row ${step.status.toLowerCase()}`} key={step.id}>
                    <span className={`step-dot ${step.status.toLowerCase()}`} />
                    <div>
                      <strong>{step.stepName}</strong>
                      <span className="muted">
                        {step.status} · attempt {step.attemptCount}
                      </span>
                      {step.status === "FAILED" && failureSummary?.failedStep === step.stepName ? (
                        <span className="step-error">{failureSummary.detail}</span>
                      ) : null}
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

          {hasPayload(run.outputPayload) && !hasPayload(run.errorPayload) ? (
            <section className="panel">
              <h2>Run output</h2>
              <pre className="json-block">{stableJson(run.outputPayload)}</pre>
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
                  <th>Cost</th>
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
                    <td>{formatEstimatedCostUsd(cost.estimatedCostUsd)}</td>
                  </tr>
                ))}
                {run.costs.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="muted">
                      No provider usage recorded.
                    </td>
                  </tr>
                ) : null}
                {run.costs.length > 0 ? (
                  <tr>
                    <td colSpan={6}>
                      <strong>Total</strong>
                    </td>
                    <td>
                      <strong>{formatEstimatedCostUsd(totalEstimatedCost)}</strong>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </section>

          <section className="panel">
            <h2>Provider batch jobs</h2>
            <table className="table">
              <thead>
                <tr>
                  <th>Operation</th>
                  <th>Status</th>
                  <th>Model</th>
                  <th>Requests</th>
                  <th>Files</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {run.providerBatchJobs.map((job) => (
                  <tr key={job.id}>
                    <td>
                      <strong>{job.operation}</strong>
                      <span className="muted">{shortId(job.providerJobId ?? job.id)}</span>
                    </td>
                    <td>
                      <span className={`badge ${job.status.toLowerCase()}`}>{job.status}</span>
                      {hasPayload(job.importError) ? <span className="step-error">Import failed</span> : null}
                    </td>
                    <td>{job.model}</td>
                    <td>
                      {job.totalRequests ?? "-"} total, {job.succeededRequests ?? "-"} ok, {job.failedRequests ?? "-"} failed
                    </td>
                    <td>
                      <span className="muted">input {shortId(job.inputFileId)}</span>
                      <span className="muted">output {shortId(job.outputFileId)}</span>
                      <span className="muted">error {shortId(job.errorFileId)}</span>
                    </td>
                    <td>
                      {isBatchImportRetryable(job) ? (
                        <button
                          className="btn secondary"
                          type="button"
                          disabled={retrying !== null}
                          onClick={() => void retryBatchImport(job.id)}
                        >
                          Retry import
                        </button>
                      ) : (
                        "-"
                      )}
                    </td>
                  </tr>
                ))}
                {run.providerBatchJobs.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="muted">
                      No provider batch jobs recorded.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </section>

          {run.retryAttempts && run.retryAttempts.length > 0 ? (
            <section className="panel">
              <h2>Retry attempts</h2>
              <div className="retry-list">
                {run.retryAttempts.map((attempt) => (
                  <button className="link-button" type="button" key={attempt.id} onClick={() => void loadRun(attempt.id)}>
                    {shortId(attempt.id)} · {attempt.status} · {attempt.currentStep ?? "No active step"}
                  </button>
                ))}
              </div>
            </section>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

export function FailureDiagnosis({ summary, payload }: FailureDiagnosisProps) {
  const issueGroups = groupedFailureIssues(summary);
  const nextAction = nextActionForFailure(summary);

  return (
    <section className="failure-panel" aria-label="Run failure diagnosis">
      <div className="failure-heading">
        <div className="failure-icon">
          <AlertTriangle size={20} aria-hidden="true" />
        </div>
        <div>
          <p className="eyebrow">Failure diagnosis</p>
          <h2>{summary.title}</h2>
          <p>{summary.detail}</p>
        </div>
      </div>

      <dl className="failure-facts">
        {summary.failedStep ? (
          <div>
            <dt>Failed at</dt>
            <dd>{summary.failedStep}</dd>
          </div>
        ) : null}
        {summary.failureType ? (
          <div>
            <dt>Failure type</dt>
            <dd>{summary.failureType}</dd>
          </div>
        ) : null}
        {summary.provider ? (
          <div>
            <dt>Provider</dt>
            <dd>{summary.provider}</dd>
          </div>
        ) : null}
        {summary.model ? (
          <div>
            <dt>Model</dt>
            <dd>{summary.model}</dd>
          </div>
        ) : null}
      </dl>

      {nextAction ? <p className="failure-next">{nextAction}</p> : null}

      {issueGroups.length > 0 ? (
        <div className="failure-issues">
          <h3>Invalid fields</h3>
          <div className="failure-issue-groups">
            {issueGroups.map((group) => (
              <article className="failure-issue-group" key={group.key}>
                <h4>{group.label}</h4>
                <ul>
                  {group.issues.map((issue) => (
                    <li key={`${group.key}:${issue.path.join(".")}`}>
                      <code>{issue.field}</code>
                      <span>{issueDetail(issue)}</span>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </div>
      ) : null}

      <details className="technical-details">
        <summary>Technical details</summary>
        <pre className="json-block">{stableJson(payload)}</pre>
      </details>
    </section>
  );
}

function stableJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function hasPayload(value: unknown) {
  return value !== null && value !== undefined;
}

export function shortId(value: string | null | undefined) {
  return value ? value.slice(0, 8) : "-";
}

export function isRunRetryable(status: string) {
  return status === "FAILED" || status === "CANCELLED";
}

export function isBatchImportRetryable(job: Pick<ProviderBatchJob, "outputFileId" | "status">) {
  return Boolean(job.outputFileId) && ["IMPORT_FAILED", "SUCCEEDED", "IMPORTED"].includes(job.status);
}

export function totalEstimatedCostUsd(costs: Array<{ estimatedCostUsd: string | null }>) {
  let total = 0;
  let hasCost = false;

  for (const cost of costs) {
    const parsed = parseCostUsd(cost.estimatedCostUsd);
    if (parsed === undefined) {
      continue;
    }

    total += parsed;
    hasCost = true;
  }

  return hasCost ? total.toFixed(6) : null;
}

export function formatEstimatedCostUsd(value: string | number | null | undefined) {
  const parsed = parseCostUsd(value);
  if (parsed === undefined) {
    return "-";
  }

  if (parsed === 0) {
    return "$0.00";
  }

  if (parsed < 0.01) {
    return `<$0.01`;
  }

  return `$${parsed.toFixed(2)}`;
}

function parseCostUsd(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }

  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function failureSummaryForRun(run: IngestionRun) {
  if (!hasPayload(run.errorPayload)) {
    return null;
  }

  return run.failureSummary ?? null;
}

function groupedFailureIssues(summary: WorkflowFailureSummary) {
  const groups = new Map<string, WorkflowFailureSummary["issues"]>();
  for (const issue of summary.issues) {
    const key = issue.candidateIndex === undefined ? "run" : `candidate-${issue.candidateIndex}`;
    groups.set(key, [...(groups.get(key) ?? []), issue]);
  }

  return [...groups.entries()].map(([key, issues]) => ({
    key,
    label: key === "run" ? "Run payload" : `Candidate ${Number(key.replace("candidate-", "")) + 1}`,
    issues
  }));
}

function nextActionForFailure(summary: WorkflowFailureSummary) {
  if (summary.failedStep === "extract_question_candidates" && summary.issues.length > 0) {
    return "OCR completed; extraction response did not match the required candidate schema.";
  }

  return undefined;
}

function issueDetail(issue: WorkflowFailureSummary["issues"][number]) {
  if (issue.message !== "Required") {
    return issue.message.endsWith(".") ? issue.message : `${issue.message}.`;
  }

  const expected = issue.expected ? ` Expected ${issue.expected}.` : "";
  const received = issue.received ? ` Received ${issue.received}.` : "";
  return `${issue.message}.${expected}${received}`;
}
