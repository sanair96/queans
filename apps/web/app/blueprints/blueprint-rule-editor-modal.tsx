"use client";

import { Save, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { BlueprintJsonValue } from "./blueprint-json-editor";
import { MarkingSchemeReviewForm } from "./marking-scheme-review-form";

interface BlueprintRuleEditorModalProps {
  open: boolean;
  value: BlueprintJsonValue;
  dirty: boolean;
  saving: boolean;
  canSave: boolean;
  notice: string;
  onChange: (value: BlueprintJsonValue) => void;
  onSave: () => Promise<boolean>;
  onClose: () => void;
  onDiscard: () => void;
}

export function BlueprintRuleEditorModal({
  open,
  value,
  dirty,
  saving,
  canSave,
  notice,
  onChange,
  onSave,
  onClose,
  onDiscard
}: BlueprintRuleEditorModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !open) return;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, [open]);

  useEffect(() => {
    if (!open) setConfirmDiscard(false);
  }, [open]);

  if (!open) return null;

  function requestClose() {
    if (saving) return;
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  }

  async function save() {
    if (await onSave()) onClose();
  }

  return (
    <dialog
      aria-describedby="rule-editor-description"
      aria-labelledby="rule-editor-title"
      className="rule-editor-modal"
      ref={dialogRef}
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div className="rule-editor-modal-shell">
        <header className="rule-editor-modal-head">
          <div>
            <p className="eyebrow">Teacher review</p>
            <h2 id="rule-editor-title">Review your Blueprint</h2>
            <p className="muted" id="rule-editor-description">Check the paper details, assessment sections, question groups, marks, choices, and source pages before saving.</p>
          </div>
          <button aria-label="Close rule editor" className="rule-modal-close" disabled={saving} type="button" onClick={requestClose}><X size={20} aria-hidden="true" /></button>
        </header>
        <div className="rule-editor-modal-body">
          <MarkingSchemeReviewForm value={value} onChange={onChange} disabled={!canSave || saving} />
        </div>
        <footer className="rule-editor-modal-foot">
          <p className={notice ? "rule-editor-notice" : "editor-caption"}>{notice || (dirty ? "Changes ready to save" : "Review the extracted values, then save your Blueprint")}</p>
          <div className="button-row">
            <button className="btn secondary" disabled={saving} type="button" onClick={requestClose}>Close</button>
            <button className="btn" disabled={!canSave || saving} type="button" onClick={() => void save()}>
              <Save size={16} aria-hidden="true" /> {saving ? "Saving" : "Save Blueprint"}
            </button>
          </div>
        </footer>
        {confirmDiscard ? (
          <div className="rule-discard-confirmation" role="alertdialog" aria-modal="true" aria-labelledby="discard-rules-title">
            <div>
              <h3 id="discard-rules-title">Discard unsaved changes?</h3>
              <p>Your edits have not been saved to this Blueprint.</p>
            </div>
            <div className="button-row">
              <button className="btn secondary" type="button" onClick={() => setConfirmDiscard(false)}>Keep editing</button>
              <button className="btn danger" type="button" onClick={() => { onDiscard(); onClose(); }}>Discard changes</button>
            </div>
          </div>
        ) : null}
      </div>
    </dialog>
  );
}
