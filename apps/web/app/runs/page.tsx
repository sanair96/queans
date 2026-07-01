export default function RunsPage() {
  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">Runs</p>
          <h1>Ingestion run lookup</h1>
          <p className="muted">Use the run ID returned after upload to query `/api/ingestions/:id` while the workflow is active.</p>
        </div>
      </header>
      <section className="panel flat">
        <p className="muted">A searchable runs list will be backed by the workflow read model once ingestion history is populated.</p>
      </section>
    </>
  );
}

