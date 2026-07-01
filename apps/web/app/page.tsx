import { UploadPanel } from "./upload-panel";

export default function UploadPage() {
  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">Ingestion</p>
          <h1>Upload a source paper</h1>
          <p className="muted">The file goes to private R2 first. OCR, extraction, validation, and review run asynchronously.</p>
        </div>
      </header>
      <div className="grid two">
        <UploadPanel />
        <section className="panel flat">
          <h2>Pipeline</h2>
          <table className="table">
            <tbody>
              <tr>
                <td>1</td>
                <td>Direct R2 upload</td>
                <td><span className="badge">sync</span></td>
              </tr>
              <tr>
                <td>2</td>
                <td>Upload verification and workflow start outbox</td>
                <td><span className="badge">quick</span></td>
              </tr>
              <tr>
                <td>3</td>
                <td>Mistral OCR 4 and structured extraction</td>
                <td><span className="badge">async</span></td>
              </tr>
              <tr>
                <td>4</td>
                <td>Confidence policy and human review</td>
                <td><span className="badge">gated</span></td>
              </tr>
              <tr>
                <td>5</td>
                <td>Approved question-bank commit</td>
                <td><span className="badge">audited</span></td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>
    </>
  );
}

