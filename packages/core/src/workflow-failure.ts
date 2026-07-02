export interface WorkflowFailurePayload {
  message: string;
  name?: string;
  stack?: string;
  cause?: WorkflowFailurePayload;
}

export interface WorkflowFailureIssue {
  path: Array<string | number>;
  field: string;
  message: string;
  code?: string;
  expected?: string;
  received?: string;
  candidateIndex?: number;
}

export interface WorkflowFailureSummary {
  title: string;
  detail: string;
  failedStep?: string;
  failureType?: string;
  rootCause: string;
  provider?: string;
  model?: string;
  issues: WorkflowFailureIssue[];
}

interface WorkflowFailureSummaryOptions {
  failedStep?: string | null;
  provider?: string | null;
  model?: string | null;
}

export function serializeWorkflowFailure(error: unknown, depth = 0): WorkflowFailurePayload {
  if (error instanceof Error) {
    const payload: WorkflowFailurePayload = {
      message: error.message || "Workflow failed"
    };
    if (error.name) {
      payload.name = error.name;
    }
    if (error.stack) {
      payload.stack = error.stack;
    }
    if (error.cause !== undefined && depth < 3) {
      payload.cause = serializeWorkflowFailure(error.cause, depth + 1);
    }
    return payload;
  }

  if (typeof error === "string") {
    return { message: error };
  }

  return { message: "Workflow failed with a non-error value" };
}

export function summarizeWorkflowFailure(
  payload: unknown,
  options: WorkflowFailureSummaryOptions = {}
): WorkflowFailureSummary {
  const failure = parseWorkflowFailurePayload(payload);
  const root = deepestFailure(failure);
  const issues = extractZodIssues(failure);
  const failedStep = normalizedText(options.failedStep);
  const provider = normalizedText(options.provider);
  const model = normalizedText(options.model);
  const rootCause = root ? root.message : "Workflow failed";
  const title = failureTitle({ failedStep, issues });
  const summary: WorkflowFailureSummary = {
    title,
    detail: failureDetail({ failedStep, issues, rootCause }),
    rootCause,
    issues
  };
  const failureType = root?.name ?? failure?.name;

  if (failedStep) {
    summary.failedStep = failedStep;
  }
  if (failureType) {
    summary.failureType = failureType;
  }
  if (provider) {
    summary.provider = provider;
  }
  if (model) {
    summary.model = model;
  }

  return summary;
}

function failureTitle(input: { failedStep: string | undefined; issues: WorkflowFailureIssue[] }) {
  if (input.failedStep === "extract_question_candidates" && input.issues.length > 0) {
    return "Question extraction returned malformed candidates";
  }

  if (input.issues.length > 0) {
    return "Workflow failed validation";
  }

  return "Workflow failed";
}

function failureDetail(input: {
  failedStep: string | undefined;
  issues: WorkflowFailureIssue[];
  rootCause: string;
}) {
  if (input.failedStep === "extract_question_candidates" && input.issues.length > 0) {
    const candidateCount = uniqueDefined(input.issues.map((issue) => issue.candidateIndex)).length;
    const missingRequiredCount = input.issues.filter(isMissingRequiredIssue).length;
    if (missingRequiredCount === input.issues.length && candidateCount > 0) {
      return `Question extraction returned malformed candidates: ${candidateCount} ${pluralize(
        "candidate",
        candidateCount
      )} ${candidateCount === 1 ? "is" : "are"} missing required fields.`;
    }

    return `Question extraction returned malformed candidates: ${input.issues.length} validation ${pluralize(
      "issue",
      input.issues.length
    )} across ${candidateCount || "unknown"} ${candidateCount === 1 ? "candidate" : "candidates"}.`;
  }

  if (input.issues.length > 0) {
    return `Validation failed with ${input.issues.length} ${pluralize("issue", input.issues.length)}.`;
  }

  return input.rootCause;
}

function parseWorkflowFailurePayload(payload: unknown): WorkflowFailurePayload | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }

  const message = stringValue(payload.message) ?? stringValue(payload.stack) ?? "Workflow failed";
  const parsed: WorkflowFailurePayload = { message };
  const name = stringValue(payload.name);
  const stack = stringValue(payload.stack);
  const cause = parseWorkflowFailurePayload(payload.cause);

  if (name) {
    parsed.name = name;
  }
  if (stack) {
    parsed.stack = stack;
  }
  if (cause) {
    parsed.cause = cause;
  }

  return parsed;
}

function deepestFailure(failure: WorkflowFailurePayload | undefined): WorkflowFailurePayload | undefined {
  let current = failure;
  while (current?.cause) {
    current = current.cause;
  }

  return current;
}

function extractZodIssues(failure: WorkflowFailurePayload | undefined): WorkflowFailureIssue[] {
  const issueValues = failureChain(failure).flatMap((item) => {
    return [item.message, item.stack].flatMap((value) => parseZodIssuesFromText(value));
  });
  const seen = new Set<string>();
  const issues: WorkflowFailureIssue[] = [];

  for (const issueValue of issueValues) {
    const issue = normalizeZodIssue(issueValue);
    if (!issue) {
      continue;
    }

    const key = JSON.stringify([issue.path, issue.message, issue.code]);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    issues.push(issue);
  }

  return issues;
}

function failureChain(failure: WorkflowFailurePayload | undefined): WorkflowFailurePayload[] {
  const chain: WorkflowFailurePayload[] = [];
  let current = failure;
  while (current) {
    chain.push(current);
    current = current.cause;
  }

  return chain;
}

function parseZodIssuesFromText(value: string | undefined): unknown[] {
  if (!value?.includes("ZodError:")) {
    return [];
  }

  const json = jsonArrayAfterMarker(value, "ZodError:");
  if (!json) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function jsonArrayAfterMarker(value: string, marker: string) {
  const markerIndex = value.indexOf(marker);
  if (markerIndex === -1) {
    return undefined;
  }

  const start = value.indexOf("[", markerIndex + marker.length);
  if (start === -1) {
    return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (character === "\\") {
        escaping = true;
        continue;
      }
      if (character === "\"") {
        inString = false;
      }
      continue;
    }

    if (character === "\"") {
      inString = true;
      continue;
    }

    if (character === "[") {
      depth += 1;
      continue;
    }

    if (character === "]") {
      depth -= 1;
      if (depth === 0) {
        return value.slice(start, index + 1);
      }
    }
  }

  return undefined;
}

function normalizeZodIssue(issue: unknown): WorkflowFailureIssue | undefined {
  if (!isRecord(issue)) {
    return undefined;
  }

  const path = issuePath(issue.path);
  const message = stringValue(issue.message) ?? "Validation failed.";
  const field = fieldFromPath(path);
  const normalized: WorkflowFailureIssue = {
    path,
    field,
    message
  };
  const code = stringValue(issue.code);
  const expected = stringValue(issue.expected);
  const received = stringValue(issue.received);
  const candidateIndex = candidateIndexFromPath(path);

  if (code) {
    normalized.code = code;
  }
  if (expected) {
    normalized.expected = expected;
  }
  if (received) {
    normalized.received = received;
  }
  if (candidateIndex !== undefined) {
    normalized.candidateIndex = candidateIndex;
  }

  return normalized;
}

function issuePath(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string | number => typeof item === "string" || typeof item === "number");
}

function fieldFromPath(path: Array<string | number>) {
  const last = path.at(-1);
  return typeof last === "string" ? last : path.map(String).join(".");
}

function candidateIndexFromPath(path: Array<string | number>) {
  const candidatesIndex = path.indexOf("candidates");
  const candidateIndex = candidatesIndex >= 0 ? path[candidatesIndex + 1] : undefined;
  return typeof candidateIndex === "number" ? candidateIndex : undefined;
}

function isMissingRequiredIssue(issue: WorkflowFailureIssue) {
  return issue.message === "Required" || (issue.code === "invalid_type" && issue.received === "undefined");
}

function pluralize(word: string, count: number) {
  return count === 1 ? word : `${word}s`;
}

function uniqueDefined(values: Array<number | undefined>) {
  return [...new Set(values.filter((value): value is number => value !== undefined))];
}

function normalizedText(value: string | null | undefined) {
  return value?.trim() || undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
