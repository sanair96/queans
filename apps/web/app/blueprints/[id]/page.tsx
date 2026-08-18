import Link from "next/link";

import { apiGet } from "../../api-client";
import { BlueprintWorkbench, type BlueprintDocument, type BlueprintOcrPage } from "../blueprint-workbench";

export default async function BlueprintDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await loadBlueprint(id);

  if (data.error) {
    return (
      <section className="panel empty-state">
        <strong>{data.error}</strong>
        <Link className="btn secondary" href="/blueprints">Back to Blueprints</Link>
      </section>
    );
  }

  return <BlueprintWorkbench initialBlueprint={data.blueprint} initialPages={data.pages} />;
}

async function loadBlueprint(id: string) {
  try {
    const [blueprint, pages] = await Promise.all([
      apiGet<BlueprintDocument>(`/api/blueprints/${id}`),
      apiGet<{ pages: BlueprintOcrPage[] }>(`/api/blueprints/${id}/ocr-pages`)
    ]);
    return { blueprint, pages: pages.pages, error: undefined };
  } catch (error) {
    return {
      blueprint: undefined as never,
      pages: [] as BlueprintOcrPage[],
      error: error instanceof Error ? error.message : "Blueprint failed to load."
    };
  }
}
