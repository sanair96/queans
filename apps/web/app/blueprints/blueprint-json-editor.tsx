"use client";

import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

export type BlueprintJsonValue =
  | null
  | boolean
  | number
  | string
  | BlueprintJsonValue[]
  | { [key: string]: BlueprintJsonValue };

type JsonKind = "array" | "boolean" | "null" | "number" | "object" | "string";

interface BlueprintJsonEditorProps {
  value: BlueprintJsonValue;
  onChange: (value: BlueprintJsonValue) => void;
  disabled?: boolean;
}

export interface BlueprintRuleSection {
  id: string;
  label: string;
}

export function blueprintRuleSections(value: BlueprintJsonValue): BlueprintRuleSection[] {
  if (!isJsonObject(value)) return [{ id: "__root__", label: "Blueprint rules" }];
  const entries = Object.keys(value);
  return entries.length > 0 ? entries.map((key) => ({ id: key, label: key })) : [{ id: "__root__", label: "Blueprint rules" }];
}

export function BlueprintJsonEditor({ value, onChange, disabled = false }: BlueprintJsonEditorProps) {
  const sections = blueprintRuleSections(value);
  const [activeSection, setActiveSection] = useState(sections[0]?.id ?? "__root__");

  useEffect(() => {
    if (!sections.some((section) => section.id === activeSection)) setActiveSection(sections[0]?.id ?? "__root__");
  }, [activeSection, sections]);

  const rootObject = isJsonObject(value);
  const sectionValue = rootObject && activeSection !== "__root__" ? value[activeSection] ?? null : value;
  const sectionLabel = sections.find((section) => section.id === activeSection)?.label ?? "Blueprint rules";

  function updateSection(nextValue: BlueprintJsonValue) {
    if (rootObject && activeSection !== "__root__") {
      onChange({ ...value, [activeSection]: nextValue });
      return;
    }
    onChange(nextValue);
  }

  return (
    <div className="rule-editor-layout">
      <nav className="rule-section-nav" aria-label="Rule sections">
        <span className="rule-section-nav-label">Sections</span>
        {sections.map((section) => (
          <button
            className={`rule-section-tab ${section.id === activeSection ? "active" : ""}`}
            key={section.id}
            type="button"
            onClick={() => setActiveSection(section.id)}
          >
            {section.label}
          </button>
        ))}
      </nav>
      <section className="rule-section-content" aria-label={`${sectionLabel} fields`}>
        <div className="rule-section-heading">
          <p className="eyebrow">Editing section</p>
          <h3>{sectionLabel}</h3>
        </div>
        <RuleValueEditor label={sectionLabel} value={sectionValue} onChange={updateSection} disabled={disabled} root />
      </section>
    </div>
  );
}

function RuleValueEditor({
  label,
  value,
  onChange,
  onDelete,
  onRename,
  disabled = false,
  root = false
}: {
  label: string;
  value: BlueprintJsonValue;
  onChange: (value: BlueprintJsonValue) => void;
  onDelete?: (() => void) | undefined;
  onRename?: ((value: string) => void) | undefined;
  disabled?: boolean;
  root?: boolean;
}) {
  const kind = jsonKind(value);
  const collection = isJsonObject(value) || Array.isArray(value);

  return (
    <article className={`rule-field-card ${collection ? "collection" : ""} ${root ? "root" : ""}`}>
      <div className="rule-field-head">
        {onRename ? <RuleKeyInput value={label} onCommit={onRename} disabled={disabled} /> : <strong>{label}</strong>}
        <div className="rule-field-actions">
          <select
            aria-label={`${label} value type`}
            className="rule-kind-select"
            disabled={disabled}
            value={kind}
            onChange={(event) => onChange(defaultValueForKind(event.target.value as JsonKind))}
          >
            <option value="object">Object</option>
            <option value="array">Array</option>
            <option value="string">Text</option>
            <option value="number">Number</option>
            <option value="boolean">True / false</option>
            <option value="null">Empty</option>
          </select>
          {onDelete ? (
            <button aria-label={`Delete ${label}`} className="rule-delete" disabled={disabled} type="button" onClick={onDelete}>
              <Trash2 size={16} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>
      {typeof value === "string" ? (
        <textarea aria-label={`${label} text`} className="rule-text-input" disabled={disabled} value={value} onChange={(event) => onChange(event.target.value)} />
      ) : null}
      {typeof value === "number" ? (
        <input
          aria-label={`${label} number`}
          className="rule-number-input"
          disabled={disabled}
          inputMode="decimal"
          type="number"
          value={String(value)}
          onChange={(event) => {
            const number = Number(event.target.value);
            if (Number.isFinite(number)) onChange(number);
          }}
        />
      ) : null}
      {typeof value === "boolean" ? (
        <label className="rule-boolean-input"><input checked={value} disabled={disabled} type="checkbox" onChange={(event) => onChange(event.target.checked)} /> {value ? "True" : "False"}</label>
      ) : null}
      {value === null ? <p className="rule-null-value">No value</p> : null}
      {isJsonObject(value) ? <ObjectFields value={value} onChange={onChange} disabled={disabled} /> : null}
      {Array.isArray(value) ? <ArrayItems value={value} onChange={onChange} disabled={disabled} /> : null}
    </article>
  );
}

function RuleKeyInput({ value, onCommit, disabled }: { value: string; onCommit: (value: string) => void; disabled: boolean }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      aria-label="Field name"
      className="rule-key-input"
      disabled={disabled}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        const trimmed = draft.trim();
        if (trimmed) onCommit(trimmed);
        else setDraft(value);
      }}
    />
  );
}

function ObjectFields({ value, onChange, disabled }: { value: Record<string, BlueprintJsonValue>; onChange: (value: BlueprintJsonValue) => void; disabled: boolean }) {
  const entries = Object.entries(value);
  function updateField(key: string, nextValue: BlueprintJsonValue) {
    onChange({ ...value, [key]: nextValue });
  }
  function deleteField(key: string) {
    const nextValue = { ...value };
    delete nextValue[key];
    onChange(nextValue);
  }
  function renameField(key: string, nextKey: string) {
    if (nextKey === key || Object.hasOwn(value, nextKey)) return;
    onChange(Object.fromEntries(entries.map(([entryKey, entryValue]) => [entryKey === key ? nextKey : entryKey, entryValue])));
  }
  return (
    <div className="rule-field-list">
      {entries.map(([key, fieldValue]) => (
        <RuleValueEditor
          key={key}
          label={key}
          value={fieldValue}
          onChange={(nextValue) => updateField(key, nextValue)}
          onDelete={() => deleteField(key)}
          onRename={(nextKey) => renameField(key, nextKey)}
          disabled={disabled}
        />
      ))}
      <button className="rule-add" disabled={disabled} type="button" onClick={() => onChange({ ...value, [nextObjectKey(value)]: "" })}><Plus size={16} aria-hidden="true" /> Add field</button>
    </div>
  );
}

function ArrayItems({ value, onChange, disabled }: { value: BlueprintJsonValue[]; onChange: (value: BlueprintJsonValue) => void; disabled: boolean }) {
  return (
    <div className="rule-field-list">
      {value.map((item, index) => (
        <RuleValueEditor
          key={index}
          label={`Item ${index + 1}`}
          value={item}
          onChange={(nextValue) => onChange(value.map((entry, entryIndex) => entryIndex === index ? nextValue : entry))}
          onDelete={() => onChange(value.filter((_entry, entryIndex) => entryIndex !== index))}
          disabled={disabled}
        />
      ))}
      <button className="rule-add" disabled={disabled} type="button" onClick={() => onChange([...value, ""])}><Plus size={16} aria-hidden="true" /> Add item</button>
    </div>
  );
}

function jsonKind(value: BlueprintJsonValue): JsonKind {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  return "string";
}

function defaultValueForKind(kind: JsonKind): BlueprintJsonValue {
  switch (kind) {
    case "array": return [];
    case "boolean": return false;
    case "null": return null;
    case "number": return 0;
    case "object": return {};
    case "string": return "";
  }
}

function nextObjectKey(value: Record<string, BlueprintJsonValue>) {
  let number = 1;
  while (Object.hasOwn(value, `field_${number}`)) number += 1;
  return `field_${number}`;
}

export function isBlueprintJsonValue(value: unknown): value is BlueprintJsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isBlueprintJsonValue);
  if (!value || typeof value !== "object") return false;
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every((entry) => isBlueprintJsonValue(entry));
}

function isJsonObject(value: BlueprintJsonValue): value is Record<string, BlueprintJsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
