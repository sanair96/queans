interface ApiErrorBody {
  error?: unknown;
  message?: unknown;
  issues?: unknown;
  expectedMimeType?: unknown;
  actualMimeType?: unknown;
  status?: unknown;
}

export async function assertOk(response: Response, action: string) {
  if (response.ok) {
    return;
  }

  throw new Error(await apiErrorMessage(response, action));
}

export async function apiErrorMessage(response: Response, action: string) {
  const body = await readApiErrorBody(response);
  const detail = body.json ? apiErrorDetail(body.json) : body.text;
  return detail ? `${action} failed: ${detail}` : `${action} failed with ${response.status}`;
}

export function apiErrorDetail(body: ApiErrorBody) {
  const errorCode = stringValue(body.error);

  if (errorCode === "VALIDATION_ERROR") {
    return validationErrorDetail(body.issues);
  }

  if (errorCode === "R2_OBJECT_CONTENT_TYPE_MISMATCH") {
    return `Uploaded file type ${mimeTypeLabel(body.actualMimeType)} did not match expected ${mimeTypeLabel(
      body.expectedMimeType
    )}.`;
  }

  if (errorCode === "UPLOAD_SIZE_MISMATCH") {
    return "Uploaded file size did not match the completed upload request.";
  }

  if (errorCode === "R2_OBJECT_SIZE_MISMATCH") {
    return "Uploaded object size did not match the upload session.";
  }

  if (errorCode === "REVIEW_ITEM_ALREADY_CLOSED") {
    const status = stringValue(body.status);
    return status ? `This review item is already ${status.toLowerCase().replaceAll("_", " ")}.` : "This review item is already closed.";
  }

  const message = stringValue(body.message);
  return message ?? (errorCode ? humanizeErrorCode(errorCode) : undefined);
}

async function readApiErrorBody(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body: unknown = await response.json().catch(() => undefined);
    return { json: isRecord(body) ? body : undefined };
  }

  const text = await response.text().catch(() => "");
  return { text: textErrorDetail(text) };
}

function textErrorDetail(value: string) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return undefined;
  }

  const xmlError = xmlErrorDetail(value);
  return xmlError ?? truncatedText(normalized);
}

function xmlErrorDetail(value: string) {
  const code = xmlTagValue(value, "Code");
  const message = xmlTagValue(value, "Message");

  if (code && message) {
    return `${code}: ${message}`;
  }

  return message ?? code;
}

function xmlTagValue(value: string, tagName: string) {
  const match = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, "i").exec(value);
  const content = match?.[1];
  return content ? normalizeText(decodeXmlEntities(content)) : undefined;
}

function decodeXmlEntities(value: string) {
  return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&").replaceAll("&apos;", "'").replaceAll("&quot;", "\"");
}

function normalizeText(value: string) {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : undefined;
}

function truncatedText(value: string) {
  return value.length > 320 ? `${value.slice(0, 317)}...` : value;
}

function validationErrorDetail(issues: unknown) {
  if (!Array.isArray(issues) || issues.length === 0) {
    return "Validation failed.";
  }

  return issues.map(issueLabel).join(" ");
}

function issueLabel(issue: unknown) {
  if (!isRecord(issue)) {
    return "Validation failed.";
  }

  const message = stringValue(issue.message) ?? "Validation failed.";
  const path = issuePathLabel(issue.path);
  return path ? `${path}: ${message}` : message;
}

function issuePathLabel(path: unknown) {
  if (!Array.isArray(path) || path.length === 0) {
    return undefined;
  }

  const parts: string[] = [];
  for (const item of path) {
    if (typeof item !== "string" && typeof item !== "number") {
      return undefined;
    }
    parts.push(String(item));
  }

  return parts.join(".");
}

function mimeTypeLabel(value: unknown) {
  return stringValue(value) ?? "unknown";
}

function humanizeErrorCode(value: string) {
  return value
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(" ");
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
