"use client";

import { useState } from "react";
import Link from "next/link";
import { CheckCircle2, ListChecks, UploadCloud } from "lucide-react";

const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

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
    if (!file) {
      setStatus("Choose a PDF or image before uploading.");
      return;
    }

    setBusy(true);
    setRun(null);
    try {
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
      assertOk(initResponse);
      const init = (await initResponse.json()) as UploadInitResponse;

      setStatus("Uploading file to R2.");
      const uploadResponse = await fetch(init.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file
      });
      assertOk(uploadResponse);

      setStatus("Verifying upload and queueing workflow.");
      const completeResponse = await fetch(`${apiBaseUrl}/api/uploads/${init.uploadId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          etag: uploadResponse.headers.get("ETag") ?? undefined,
          byteSize: file.size
        })
      });
      assertOk(completeResponse);
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
      <div className="drop-zone">
        <UploadCloud size={42} aria-hidden="true" />
        <div>
          <h2>Source file</h2>
          <p className="muted">PDF, scanned paper image, or exported question paper document.</p>
        </div>
        <input
          className="file-input"
          type="file"
          accept="application/pdf,image/*"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
        <button className="btn" type="button" onClick={() => void upload()} disabled={busy}>
          <UploadCloud size={18} aria-hidden="true" />
          {busy ? "Uploading" : "Upload and queue"}
        </button>
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

function assertOk(response: Response) {
  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }
}
