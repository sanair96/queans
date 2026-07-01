"use client";

import { useState } from "react";
import Link from "next/link";
import { CheckCircle2, ListChecks, UploadCloud } from "lucide-react";

import { assertOk } from "./api-errors";

const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const maxUploadByteSize = 50 * 1024 * 1024;

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

interface PaperContextForm {
  title: string;
  board: string;
  classLevel: string;
  subject: string;
  year: string;
  schoolName: string;
  examType: string;
  uploadedBy: string;
}

const emptyPaperContext: PaperContextForm = {
  title: "",
  board: "",
  classLevel: "",
  subject: "",
  year: "",
  schoolName: "",
  examType: "",
  uploadedBy: ""
};

export function UploadPanel() {
  const [file, setFile] = useState<File | null>(null);
  const [paperContext, setPaperContext] = useState<PaperContextForm>(emptyPaperContext);
  const [status, setStatus] = useState<string>("No file selected.");
  const [run, setRun] = useState<UploadCompleteResponse | null>(null);
  const [busy, setBusy] = useState(false);

  async function upload() {
    if (!file) {
      setStatus("Choose a PDF before uploading.");
      return;
    }

    if (file.type !== "application/pdf") {
      setStatus("Only PDF uploads are supported.");
      return;
    }

    if (file.size > maxUploadByteSize) {
      setStatus("Choose a PDF that is 50 MB or smaller.");
      return;
    }

    setBusy(true);
    setRun(null);
    try {
      const paperContextPayload = buildPaperContextPayload(paperContext);

      setStatus("Creating upload session.");
      const initResponse = await fetch(`${apiBaseUrl}/api/uploads/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: file.name,
          mimeType: file.type || "application/octet-stream",
          byteSize: file.size
        })
      });
      await assertOk(initResponse, "Upload session");
      const init = (await initResponse.json()) as UploadInitResponse;

      setStatus("Uploading file to R2.");
      const uploadResponse = await fetch(init.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file
      });
      await assertOk(uploadResponse, "R2 upload");

      setStatus("Verifying upload and queueing workflow.");
      const completeResponse = await fetch(`${apiBaseUrl}/api/uploads/${init.uploadId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          etag: uploadResponse.headers.get("ETag") ?? undefined,
          byteSize: file.size,
          paperContext: paperContextPayload
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
            <p className="muted">PDF question paper, 50 MB or smaller.</p>
          </div>
          <input
            className="file-input"
            type="file"
            accept="application/pdf"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
          <button className="btn" type="button" onClick={() => void upload()} disabled={busy}>
            <UploadCloud size={18} aria-hidden="true" />
            {busy ? "Uploading" : "Upload and queue"}
          </button>
        </div>
        <div className="context-form" aria-label="Paper context">
          <TextField
            label="Title"
            value={paperContext.title}
            onChange={(title) => setPaperContext((current) => ({ ...current, title }))}
          />
          <TextField
            label="Board"
            value={paperContext.board}
            onChange={(board) => setPaperContext((current) => ({ ...current, board }))}
          />
          <TextField
            label="Class"
            value={paperContext.classLevel}
            onChange={(classLevel) => setPaperContext((current) => ({ ...current, classLevel }))}
          />
          <TextField
            label="Subject"
            value={paperContext.subject}
            onChange={(subject) => setPaperContext((current) => ({ ...current, subject }))}
          />
          <TextField
            label="Year"
            value={paperContext.year}
            inputMode="numeric"
            onChange={(year) => setPaperContext((current) => ({ ...current, year }))}
          />
          <TextField
            label="School"
            value={paperContext.schoolName}
            onChange={(schoolName) => setPaperContext((current) => ({ ...current, schoolName }))}
          />
          <TextField
            label="Exam"
            value={paperContext.examType}
            onChange={(examType) => setPaperContext((current) => ({ ...current, examType }))}
          />
          <TextField
            label="Uploaded by"
            value={paperContext.uploadedBy}
            onChange={(uploadedBy) => setPaperContext((current) => ({ ...current, uploadedBy }))}
          />
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

function TextField({
  inputMode,
  label,
  onChange,
  value
}: {
  inputMode?: "numeric";
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        value={value}
        inputMode={inputMode}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function buildPaperContextPayload(paperContext: PaperContextForm) {
  const payload = {
    title: optionalTrimmed(paperContext.title),
    board: optionalTrimmed(paperContext.board),
    classLevel: optionalTrimmed(paperContext.classLevel),
    subject: optionalTrimmed(paperContext.subject),
    year: optionalYear(paperContext.year),
    schoolName: optionalTrimmed(paperContext.schoolName),
    examType: optionalTrimmed(paperContext.examType),
    uploadedBy: optionalTrimmed(paperContext.uploadedBy)
  };

  const entries = Object.entries(payload).filter(([, value]) => value !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function optionalTrimmed(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalYear(value: string) {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const year = Number(trimmed);
  if (!Number.isInteger(year) || year < 1900 || year > 2200) {
    throw new Error("Year must be between 1900 and 2200.");
  }
  return year;
}
