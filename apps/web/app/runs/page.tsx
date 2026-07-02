import { Suspense } from "react";

import { RunLookup } from "./run-lookup";

export default function RunsPage() {
  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">Runs</p>
          <h1>Ingestion jobs</h1>
        </div>
      </header>
      <Suspense fallback={<RunLookupFallback />}>
        <RunLookup />
      </Suspense>
    </>
  );
}

function RunLookupFallback() {
  return (
    <section className="panel flat">
      <div className="lookup-form">
        <input disabled placeholder="ingestion run id" />
        <button className="btn" type="button" disabled>
          Lookup
        </button>
      </div>
    </section>
  );
}
