import Link from "next/link";

import { apiGet } from "../api-client";
import { BlueprintUploadPanel } from "./blueprint-upload-panel";

interface BlueprintListItem {
  id: string;
  title: string | null;
  originalFilename: string;
  board: string;
  subject: string | null;
  academicLevel: string | null;
  primaryLanguage: string | null;
  primaryLanguageSource: string;
  status: string;
  pageCount: number | null;
  updatedAt: string;
}

export default async function BlueprintsPage() {
  const data = await loadBlueprints();
  const groupedBlueprints = groupBlueprintsByBoard(data.items);

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">Blueprint desk</p>
          <h1>Blueprints by board</h1>
          <p className="muted">Review the source pages, confirm the document language, and inspect the extracted rule draft.</p>
        </div>
      </header>
      <BlueprintUploadPanel />
      {data.error ? (
        <section className="panel empty-state">
          <strong>{data.error}</strong>
        </section>
      ) : groupedBlueprints.length === 0 ? (
        <section className="panel empty-state">
          <strong>No Blueprint documents yet.</strong>
          <span className="muted">Upload a Blueprint to begin OCR and rule extraction.</span>
        </section>
      ) : (
        <div className="blueprint-board-list">
          {groupedBlueprints.map(([board, blueprints]) => (
            <section className="panel blueprint-board" key={board}>
              <div className="blueprint-board-head">
                <div>
                  <p className="eyebrow">Board</p>
                  <h2>{board}</h2>
                </div>
                <span className="badge">{blueprints.length} documents</span>
              </div>
              <div className="blueprint-cards">
                {blueprints.map((blueprint) => (
                  <Link className="blueprint-card" href={`/blueprints/${blueprint.id}`} key={blueprint.id}>
                    <div>
                      <strong>{blueprint.title ?? blueprint.originalFilename}</strong>
                      <p className="muted">{[blueprint.subject, blueprint.academicLevel].filter(Boolean).join(" · ") || blueprint.originalFilename}</p>
                    </div>
                    <div className="blueprint-card-meta">
                      <span className={`badge blueprint-status ${blueprint.status.toLowerCase()}`}>{formatStatus(blueprint.status)}</span>
                      <span>{blueprint.primaryLanguage ? languageLabel(blueprint.primaryLanguage) : "Language pending"}</span>
                      <span>{blueprint.pageCount === null ? "Pages pending" : `${blueprint.pageCount} pages`}</span>
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  );
}

async function loadBlueprints() {
  try {
    const data = await apiGet<{ items: BlueprintListItem[] }>("/api/blueprints?limit=100");
    return { items: data.items, error: undefined };
  } catch (error) {
    return { items: [], error: error instanceof Error ? error.message : "Blueprints failed to load." };
  }
}

function groupBlueprintsByBoard(items: BlueprintListItem[]) {
  const groups = new Map<string, BlueprintListItem[]>();
  for (const item of items) {
    const current = groups.get(item.board) ?? [];
    current.push(item);
    groups.set(item.board, current);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function formatStatus(status: string) {
  return status.replaceAll("_", " ").toLowerCase();
}

function languageLabel(tag: string) {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}
