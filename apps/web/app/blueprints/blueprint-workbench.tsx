"use client";

import Link from "next/link";
import { Check, ChevronLeft, FileText, Languages, PanelRightOpen, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";

import { assertOk } from "../api-errors";
import { apiBaseUrl } from "../api-client";
import { isBlueprintJsonValue, type BlueprintJsonValue } from "./blueprint-json-editor";
import { BlueprintRuleEditorModal } from "./blueprint-rule-editor-modal";

interface LanguageEvidence {
  tag: string;
  displayName?: string;
  confidence?: number | null;
  pageNumbers?: number[];
}

interface LanguageAnalysis {
  detectedLanguages: LanguageEvidence[];
  primaryLanguage: {
    tag: string | null;
    source: string;
    confidence: number | null;
    requiresConfirmation: boolean;
  };
  mixedLanguagePageNumbers: number[];
  multilingualRelationship: string;
}

export interface BlueprintDocument {
  id: string;
  title: string | null;
  originalFilename: string;
  board: string;
  subject: string | null;
  academicLevel: string | null;
  primaryLanguage: string | null;
  primaryLanguageSource: string;
  languageDetectionMetadata: LanguageAnalysis | null;
  status: string;
  pageCount: number | null;
  draftRulesJson: unknown;
  extractionMetadataJson: unknown;
  extractionError: string | null;
  reviewVersion: number;
}

export interface BlueprintOcrPage {
  id: string;
  pageNumber: number;
  markdownText: string;
  plainText: string | null;
  detectedLanguages: unknown;
  ocrConfidence: number | null;
}

interface BlueprintWorkbenchProps {
  initialBlueprint: BlueprintDocument;
  initialPages: BlueprintOcrPage[];
}

export function BlueprintWorkbench({ initialBlueprint, initialPages }: BlueprintWorkbenchProps) {
  const [blueprint, setBlueprint] = useState(initialBlueprint);
  const [selectedPageNumber, setSelectedPageNumber] = useState(initialPages[0]?.pageNumber ?? 0);
  const [selectedLanguage, setSelectedLanguage] = useState(blueprint.primaryLanguage ?? "");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [editedRules, setEditedRules] = useState<BlueprintJsonValue | undefined>(() =>
    isBlueprintJsonValue(initialBlueprint.draftRulesJson) ? initialBlueprint.draftRulesJson : undefined
  );
  const [savedRules, setSavedRules] = useState<BlueprintJsonValue | undefined>(() =>
    isBlueprintJsonValue(initialBlueprint.draftRulesJson) ? initialBlueprint.draftRulesJson : undefined
  );
  const [savingRules, setSavingRules] = useState(false);
  const [rulesNotice, setRulesNotice] = useState("");
  const [ruleEditorOpen, setRuleEditorOpen] = useState(false);
  const selectedPage = useMemo(
    () => initialPages.find((page) => page.pageNumber === selectedPageNumber) ?? initialPages[0],
    [initialPages, selectedPageNumber]
  );
  const languageAnalysis = blueprint.languageDetectionMetadata;
  const requiresLanguageDecision = Boolean(
    languageAnalysis && (!languageAnalysis.primaryLanguage.tag || languageAnalysis.primaryLanguage.requiresConfirmation)
  );
  const rulesDirty = JSON.stringify(editedRules) !== JSON.stringify(savedRules);

  async function confirmPrimaryLanguage() {
    if (!selectedLanguage) {
      setNotice("Choose one of the detected languages before confirming.");
      return;
    }

    setBusy(true);
    setNotice("");
    try {
      const response = await fetch(`${apiBaseUrl}/api/blueprints/${blueprint.id}/primary-language`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ primaryLanguage: selectedLanguage })
      });
      await assertOk(response, "Primary language update");
      const updated = (await response.json()) as BlueprintDocument;
      setBlueprint(updated);
      setSelectedLanguage(updated.primaryLanguage ?? selectedLanguage);
      setNotice("Primary language confirmed. Continue extraction when you are ready.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Primary language could not be confirmed.");
    } finally {
      setBusy(false);
    }
  }

  async function retryExtraction() {
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch(`${apiBaseUrl}/api/blueprints/${blueprint.id}/retry`, { method: "POST" });
      await assertOk(response, "Blueprint extraction retry");
      const queued = (await response.json()) as { status: string; mode: "FULL" | "RESUME_FROM_OCR" };
      setBlueprint((current) => ({ ...current, status: queued.status }));
      setNotice(queued.mode === "RESUME_FROM_OCR" ? "Extraction queued. Existing OCR pages will be reused." : "Ingestion queued. OCR will run again before extraction.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Blueprint extraction could not be queued.");
    } finally {
      setBusy(false);
    }
  }

  const canContinueExtraction = blueprint.status === "NEEDS_REVIEW" && !requiresLanguageDecision;
  const canRetryExtraction = blueprint.status === "FAILED";

  async function saveRules() {
    if (editedRules === undefined || !rulesDirty) {
      return false;
    }

    setSavingRules(true);
    setRulesNotice("");
    try {
      const response = await fetch(`${apiBaseUrl}/api/blueprints/${blueprint.id}/rules`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rules: editedRules, reviewVersion: blueprint.reviewVersion })
      });
      if (response.status === 409) {
        setRulesNotice("This Blueprint changed elsewhere. Reload the page before saving your edits.");
        return false;
      }
      await assertOk(response, "Blueprint save");
      const updated = (await response.json()) as BlueprintDocument;
      setBlueprint(updated);
      const updatedRules = isBlueprintJsonValue(updated.draftRulesJson) ? updated.draftRulesJson : undefined;
      setEditedRules(updatedRules);
      setSavedRules(updatedRules);
      setRulesNotice("Saved.");
      return true;
    } catch (error) {
      setRulesNotice(error instanceof Error ? error.message : "Blueprint rules could not be saved.");
      return false;
    } finally {
      setSavingRules(false);
    }
  }

  return (
    <>
      <header className="page-header blueprint-page-header">
        <div>
          <Link className="back-link" href="/blueprints"><ChevronLeft size={16} aria-hidden="true" /> Blueprints</Link>
          <p className="eyebrow">{blueprint.board}</p>
          <h1>{blueprint.title ?? blueprint.originalFilename}</h1>
          <p className="muted">{[blueprint.subject, blueprint.academicLevel, blueprint.originalFilename].filter(Boolean).join(" · ")}</p>
        </div>
        <div className="blueprint-header-meta">
          <span className={`badge blueprint-status ${blueprint.status.toLowerCase()}`}>{formatStatus(blueprint.status)}</span>
          <span>{initialPages.length} OCR pages</span>
        </div>
      </header>

      {requiresLanguageDecision ? (
        <section className="language-decision panel">
          <div className="language-decision-mark"><Languages size={22} aria-hidden="true" /></div>
          <div>
            <p className="eyebrow">Language check</p>
            <h2>Confirm the language used for the rules</h2>
            <p className="muted">The document may contain translations or multiple languages. Rules will preserve this selected language.</p>
          </div>
          <div className="language-choice-list" role="radiogroup" aria-label="Primary language">
            {languageAnalysis?.detectedLanguages.map((language) => (
              <label className={`language-choice ${selectedLanguage === language.tag ? "selected" : ""}`} key={language.tag}>
                <input
                  checked={selectedLanguage === language.tag}
                  name="primary-language"
                  type="radio"
                  value={language.tag}
                  onChange={() => setSelectedLanguage(language.tag)}
                />
                <span>
                  <strong>{languageName(language.tag, language.displayName)}</strong>
                  <small>{language.tag}{language.pageNumbers?.length ? ` · pages ${language.pageNumbers.join(", ")}` : ""}</small>
                </span>
                {language.confidence !== null && language.confidence !== undefined ? <em>{Math.round(language.confidence * 100)}%</em> : null}
              </label>
            ))}
          </div>
          <button className="btn" disabled={busy || !selectedLanguage} type="button" onClick={() => void confirmPrimaryLanguage()}>
            <Check size={17} aria-hidden="true" />
            {busy ? "Confirming" : "Confirm primary language"}
          </button>
          {notice ? <div className="status compact">{notice}</div> : null}
        </section>
      ) : (
        <section className="panel language-confirmed">
          <Check size={20} aria-hidden="true" />
          <span>Rules language: <strong>{blueprint.primaryLanguage ? languageName(blueprint.primaryLanguage) : "Not selected"}</strong></span>
          {canContinueExtraction || canRetryExtraction ? (
            <button className="btn compact" disabled={busy} type="button" onClick={() => void retryExtraction()}>
              <RotateCcw size={15} aria-hidden="true" />
              {busy ? "Queuing" : canContinueExtraction ? "Continue extraction" : "Retry extraction"}
            </button>
          ) : null}
          {notice ? <span className="muted">{notice}</span> : null}
        </section>
      )}

      {blueprint.extractionError ? <section className="status blueprint-error"><strong>Review required:</strong> {blueprint.extractionError}</section> : null}

      <section className="blueprint-workbench">
        <aside className="panel blueprint-page-rail">
          <div className="blueprint-rail-head">
            <FileText size={17} aria-hidden="true" />
            <strong>OCR pages</strong>
          </div>
          {initialPages.map((page) => (
            <button
              className={`blueprint-page-tab ${page.pageNumber === selectedPage?.pageNumber ? "active" : ""}`}
              key={page.id}
              type="button"
              onClick={() => setSelectedPageNumber(page.pageNumber)}
            >
              <span>Page {page.pageNumber}</span>
              <small>{page.ocrConfidence === null ? "OCR" : `${Math.round(page.ocrConfidence * 100)}%`}</small>
            </button>
          ))}
        </aside>
        <article className="panel blueprint-ocr-sheet">
          <div className="blueprint-pane-title"><FileText size={17} aria-hidden="true" /><h2>OCR source</h2></div>
          {selectedPage ? <pre>{selectedPage.markdownText}</pre> : <p className="muted">OCR pages are still being prepared.</p>}
        </article>
        <article className="panel blueprint-rules-preview">
          <div className="blueprint-pane-head">
            <div className="blueprint-pane-title"><PanelRightOpen size={17} aria-hidden="true" /><h2>Rule editor</h2></div>
          </div>
          {editedRules === undefined ? (
            <div className="blueprint-preview-empty">
              <strong>Rule draft pending</strong>
              <p className="muted">The extracted Blueprint structure appears here after rule extraction completes.</p>
            </div>
          ) : (
            <>
              <div className="blueprint-rule-summary">
                <strong>{rulesDirty ? "Unsaved rule edits" : "Extracted rule draft"}</strong>
                <p className="muted">Open the focused editor to read and modify the extracted values without the nested tree layout.</p>
                <button className="btn compact" type="button" onClick={() => setRuleEditorOpen(true)}>Open rule editor</button>
              </div>
              {rulesNotice ? <div className="status compact">{rulesNotice}</div> : null}
            </>
          )}
        </article>
      </section>
      {editedRules !== undefined ? (
        <BlueprintRuleEditorModal
          open={ruleEditorOpen}
          value={editedRules}
          dirty={rulesDirty}
          saving={savingRules}
          canSave={blueprint.status === "READY"}
          notice={rulesNotice}
          onChange={(value) => {
            setEditedRules(value);
            setRulesNotice("");
          }}
          onSave={saveRules}
          onClose={() => setRuleEditorOpen(false)}
          onDiscard={() => {
            setEditedRules(savedRules);
            setRulesNotice("");
          }}
        />
      ) : null}
    </>
  );
}

function formatStatus(status: string) {
  return status.replaceAll("_", " ").toLowerCase();
}

function languageName(tag: string, displayName?: string) {
  if (displayName) return displayName;
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}
