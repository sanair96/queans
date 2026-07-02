"use client";

import { useState } from "react";
import Link from "next/link";
import { CheckCircle2, ListChecks, UploadCloud } from "lucide-react";

import { assertOk } from "./api-errors";

const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const maxUploadByteSize = 50 * 1024 * 1024;
const supportedDocumentTypes = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text"
] as const;
const supportedDocumentAccept =
  "application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.oasis.opendocument.text,.pdf,.docx,.pptx,.odt";
const supportedDocumentLabel = "PDF, DOCX, PPTX, or ODT";
const missingUploadFileMessage = `Choose a ${supportedDocumentLabel} document before uploading.`;
const unsupportedUploadTypeMessage = `Only ${supportedDocumentLabel} uploads are supported.`;
const oversizedUploadFileMessage = `Choose a ${supportedDocumentLabel} document that is 50 MB or smaller.`;

interface UploadInitResponse {
  uploadId: string;
  uploadUrl: string;
  expiresAt: string;
}

interface UploadCompleteResponse {
  sourcePaperId: string;
  ingestionRunId: string;
  status: string;
}

export function UploadPanel() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<string>("No file selected.");
  const [run, setRun] = useState<UploadCompleteResponse | null>(null);
  const [busy, setBusy] = useState(false);

  async function upload() {
    const selectedFile = file;
    setRun(null);
    if (!selectedFile) {
      setStatus(missingUploadFileMessage);
      return;
    }

    const validationMessage = uploadFileValidationMessage(selectedFile);
    if (validationMessage) {
      setStatus(validationMessage);
      return;
    }

    setBusy(true);
    try {
      setStatus("Creating upload session.");
      const initResponse = await fetch(`${apiBaseUrl}/api/uploads/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: selectedFile.name,
          mimeType: selectedFile.type || "application/octet-stream",
          byteSize: selectedFile.size
        })
      });
      await assertOk(initResponse, "Upload session");
      const init = (await initResponse.json()) as UploadInitResponse;

      setStatus("Uploading file to R2.");
      const uploadResponse = await fetch(init.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": selectedFile.type || "application/octet-stream" },
        body: selectedFile
      });
      await assertOk(uploadResponse, "R2 upload");

      setStatus("Verifying upload and queueing workflow.");
      const completeResponse = await fetch(`${apiBaseUrl}/api/uploads/${init.uploadId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          etag: uploadResponse.headers.get("ETag") ?? undefined,
          byteSize: selectedFile.size
        })
      });
      await assertOk(completeResponse, "Upload verification");
      const complete = (await completeResponse.json()) as UploadCompleteResponse;
      setRun(complete);
      setStatus("Queued for asynchronous processing.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="upload-layout">
        <div className="drop-zone">
          <UploadCloud size={42} aria-hidden="true" />
          <div>
            <h2>Source file</h2>
            <p className="muted">Question paper document, 50 MB or smaller.</p>
          </div>
          <input
            className="file-input"
            type="file"
            accept={supportedDocumentAccept}
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
          <button className="btn" type="button" onClick={() => void upload()} disabled={busy}>
            <UploadCloud size={18} aria-hidden="true" />
            {busy ? "Uploading" : "Upload and queue"}
          </button>
        </div>
      </div>
      <div className="status">
        <strong>{status}</strong>
        {run ? (
          <p className="muted">
            <CheckCircle2 size={16} aria-hidden="true" /> Run {run.ingestionRunId} is {run.status}.
          </p>
        ) : null}
        {run ? (
          <Link className="btn secondary inline-link" href={`/runs?run=${run.ingestionRunId}`}>
            <ListChecks size={16} aria-hidden="true" />
            Open run
          </Link>
        ) : null}
      </div>
    </section>
  );
}

export function uploadFileValidationMessage(file: Pick<File, "type" | "size"> | null) {
  if (!file) {
    return missingUploadFileMessage;
  }

  if (!supportedDocumentTypes.some((mimeType) => mimeType === file.type)) {
    return unsupportedUploadTypeMessage;
  }

  if (file.size > maxUploadByteSize) {
    return oversizedUploadFileMessage;
  }

  return undefined;
}
