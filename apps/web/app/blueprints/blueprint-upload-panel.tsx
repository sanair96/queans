"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileCheck2, FileUp, LoaderCircle, UploadCloud } from "lucide-react";
import { useRef, useState, type ChangeEvent, type DragEvent, type KeyboardEvent } from "react";

import { assertOk } from "../api-errors";
import { apiBaseUrl } from "../api-client";

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

interface BlueprintUploadInitResponse {
  uploadId: string;
  uploadUrl: string;
}

interface BlueprintUploadCompleteResponse {
  blueprintDocumentId: string;
  workflowRunId?: string;
  status: string;
}

export function BlueprintUploadPanel() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [queuedBlueprint, setQueuedBlueprint] = useState<BlueprintUploadCompleteResponse | null>(null);

  function chooseFile(candidate: File | null) {
    setQueuedBlueprint(null);
    const validationMessage = blueprintUploadFileValidationMessage(candidate);
    if (validationMessage) {
      setFile(null);
      setStatus(validationMessage);
      return;
    }
    setFile(candidate);
    setStatus("");
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    chooseFile(event.target.files?.[0] ?? null);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragActive(false);
    if (busy) return;
    chooseFile(event.dataTransfer.files?.[0] ?? null);
  }

  function onZoneKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (busy || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    inputRef.current?.click();
  }

  function clearFile() {
    setFile(null);
    setStatus("");
    setQueuedBlueprint(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function upload() {
    if (!file || busy) return;

    setBusy(true);
    setQueuedBlueprint(null);
    try {
      setStatus("Creating secure Blueprint upload.");
      const initResponse = await fetch(`${apiBaseUrl}/api/blueprints/uploads/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: file.name,
          mimeType: file.type || "application/octet-stream",
          byteSize: file.size
        })
      });
      await assertOk(initResponse, "Blueprint upload session");
      const init = (await initResponse.json()) as BlueprintUploadInitResponse;

      setStatus("Uploading Blueprint document.");
      const r2Response = await fetch(init.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file
      });
      await assertOk(r2Response, "Blueprint document upload");

      setStatus("Verifying the document and queueing extraction.");
      const completeResponse = await fetch(`${apiBaseUrl}/api/blueprints/uploads/${init.uploadId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ etag: r2Response.headers.get("ETag") ?? undefined, byteSize: file.size })
      });
      await assertOk(completeResponse, "Blueprint upload verification");
      const complete = (await completeResponse.json()) as BlueprintUploadCompleteResponse;
      setQueuedBlueprint(complete);
      setStatus("Blueprint queued for OCR and rule extraction.");
      router.refresh();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Blueprint upload failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="blueprint-upload panel" aria-labelledby="blueprint-upload-title">
      <div className="blueprint-upload-head">
        <div>
          <p className="eyebrow">New Blueprint</p>
          <h2 id="blueprint-upload-title">Add a rules document</h2>
          <p className="muted">Upload the source once. Confirm its language and refine its details after extraction.</p>
        </div>
        <span className="blueprint-upload-limit">Up to 50 MB</span>
      </div>
      <div
        aria-label="Blueprint document drop zone"
        className={`blueprint-drop-zone ${dragActive ? "drag-active" : ""} ${busy ? "busy" : ""}`}
        onDragEnter={(event) => {
          event.preventDefault();
          if (!busy) setDragActive(true);
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          setDragActive(false);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={onDrop}
        onKeyDown={onZoneKeyDown}
        onClick={() => {
          if (!busy) inputRef.current?.click();
        }}
        role="button"
        tabIndex={busy ? -1 : 0}
      >
        <input ref={inputRef} className="visually-hidden" type="file" accept={supportedDocumentAccept} onChange={onFileChange} />
        {file ? (
          <div className="blueprint-file-ticket">
            <FileCheck2 size={26} aria-hidden="true" />
            <div>
              <strong>{file.name}</strong>
              <span>{formatFileSize(file.size)} · ready to queue</span>
            </div>
          </div>
        ) : (
          <>
            <span className="blueprint-upload-icon"><UploadCloud size={28} aria-hidden="true" /></span>
            <div>
              <strong>Drop a Blueprint document here</strong>
              <span>or press Enter to choose a file</span>
            </div>
            <small>{supportedDocumentLabel}</small>
          </>
        )}
      </div>
      <div className="blueprint-upload-actions">
        {file ? (
          <button className="btn secondary" type="button" onClick={clearFile} disabled={busy}>
            Remove file
          </button>
        ) : null}
        <button className="btn secondary" type="button" onClick={() => inputRef.current?.click()} disabled={busy}>
          <FileUp size={17} aria-hidden="true" />
          {file ? "Choose another file" : "Choose document"}
        </button>
        <button className="btn" type="button" onClick={() => void upload()} disabled={!file || busy}>
          {busy ? <LoaderCircle className="spin" size={17} aria-hidden="true" /> : <UploadCloud size={17} aria-hidden="true" />}
          {busy ? "Uploading" : "Upload Blueprint"}
        </button>
      </div>
      {status ? <p className={`blueprint-upload-status ${queuedBlueprint ? "success" : ""}`} role="status">{status}</p> : null}
      {queuedBlueprint ? (
        <Link className="blueprint-queued-link" href={`/blueprints/${queuedBlueprint.blueprintDocumentId}`}>
          Open Blueprint workspace
        </Link>
      ) : null}
    </section>
  );
}

export function blueprintUploadFileValidationMessage(file: Pick<File, "type" | "size"> | null) {
  if (!file) return `Choose a ${supportedDocumentLabel} document before uploading.`;
  if (!supportedDocumentTypes.some((mimeType) => mimeType === file.type)) return `Only ${supportedDocumentLabel} uploads are supported.`;
  if (file.size > maxUploadByteSize) return `Choose a ${supportedDocumentLabel} document that is 50 MB or smaller.`;
  return undefined;
}

export function formatFileSize(byteSize: number) {
  if (byteSize < 1024 * 1024) return `${Math.max(1, Math.ceil(byteSize / 1024))} KB`;
  return `${(byteSize / (1024 * 1024)).toFixed(byteSize < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
