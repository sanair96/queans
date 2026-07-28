"use client";

import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

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
}

export function BlueprintJsonEditor({ value, onChange }: BlueprintJsonEditorProps) {
  return <JsonEditorNode label="Blueprint rules" value={value} onChange={onChange} />;
}

function JsonEditorNode({
  label,
  value,
  onChange,
  onDelete
}: {
  label: string;
  value: BlueprintJsonValue;
  onChange: (value: BlueprintJsonValue) => void;
  onDelete?: (() => void) | undefined;
}) {
  const [expanded, setExpanded] = useState(true);
  const kind = jsonKind(value);
  const isCollection = kind === "array" || kind === "object";

  return (
    <div className={`json-editor-node ${isCollection ? "collection" : "primitive"}`}>
      <div className="json-editor-row">
        {isCollection ? (
          <button
            aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
            className="json-expand"
            type="button"
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
          </button>
        ) : <span className="json-expand-spacer" />}
        <span className="json-node-label">{label}</span>
        <select
          aria-label={`${label} value type`}
          className="json-kind-select"
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
          <button aria-label={`Delete ${label}`} className="json-delete" type="button" onClick={onDelete}>
            <Trash2 size={15} aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {typeof value === "string" ? (
        <textarea
          aria-label={`${label} text`}
          className="json-text-input"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : null}
      {typeof value === "number" ? (
        <input
          aria-label={`${label} number`}
          className="json-number-input"
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
        <label className="json-boolean-input">
          <input checked={value} type="checkbox" onChange={(event) => onChange(event.target.checked)} />
          {value ? "True" : "False"}
        </label>
      ) : null}
      {value === null ? <span className="json-null-value">No value</span> : null}

      {isCollection && expanded ? (
        <div className="json-editor-children">
          {isJsonObject(value) ? <ObjectEditor value={value} onChange={onChange} /> : null}
          {Array.isArray(value) ? <ArrayEditor value={value} onChange={onChange} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function ObjectEditor({
  value,
  onChange
}: {
  value: { [key: string]: BlueprintJsonValue };
  onChange: (value: BlueprintJsonValue) => void;
}) {
  const entries = Object.entries(value);

  function updateEntry(key: string, nextValue: BlueprintJsonValue) {
    onChange({ ...value, [key]: nextValue });
  }

  function deleteEntry(key: string) {
    const nextValue = { ...value };
    delete nextValue[key];
    onChange(nextValue);
  }

  function renameEntry(key: string, nextKey: string) {
    const trimmedKey = nextKey.trim();
    if (!trimmedKey || trimmedKey === key || Object.hasOwn(value, trimmedKey)) return;
    const nextValue = Object.fromEntries(entries.map(([entryKey, entryValue]) => [entryKey === key ? trimmedKey : entryKey, entryValue]));
    onChange(nextValue);
  }

  function addEntry() {
    onChange({ ...value, [nextObjectKey(value)]: "" });
  }

  return (
    <>
      {entries.map(([key, entryValue]) => (
        <div className="json-object-entry" key={key}>
          <input
            aria-label="Object key"
            className="json-key-input"
            value={key}
            onChange={(event) => renameEntry(key, event.target.value)}
          />
          <JsonEditorNode label={key} value={entryValue} onChange={(nextValue) => updateEntry(key, nextValue)} onDelete={() => deleteEntry(key)} />
        </div>
      ))}
      <button className="json-add" type="button" onClick={addEntry}><Plus size={15} aria-hidden="true" /> Add field</button>
    </>
  );
}

function ArrayEditor({ value, onChange }: { value: BlueprintJsonValue[]; onChange: (value: BlueprintJsonValue) => void }) {
  function updateEntry(index: number, nextValue: BlueprintJsonValue) {
    onChange(value.map((entry, entryIndex) => (entryIndex === index ? nextValue : entry)));
  }

  function deleteEntry(index: number) {
    onChange(value.filter((_entry, entryIndex) => entryIndex !== index));
  }

  return (
    <>
      {value.map((entry, index) => (
        <JsonEditorNode
          key={index}
          label={`Item ${index + 1}`}
          value={entry}
          onChange={(nextValue) => updateEntry(index, nextValue)}
          onDelete={() => deleteEntry(index)}
        />
      ))}
      <button className="json-add" type="button" onClick={() => onChange([...value, ""])}><Plus size={15} aria-hidden="true" /> Add item</button>
    </>
  );
}

function jsonKind(value: BlueprintJsonValue): JsonKind {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  throw new Error("Blueprint JSON contains an unsupported value.");
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

function nextObjectKey(value: { [key: string]: BlueprintJsonValue }) {
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

function isJsonObject(value: BlueprintJsonValue): value is { [key: string]: BlueprintJsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
