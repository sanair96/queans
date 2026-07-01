import { apiGet } from "../api-client";

interface ReviewItem {
  id: string;
  reviewType: string;
  severity: string;
  reasonCodes: unknown;
  status: string;
  createdAt: string;
  candidate: {
    cleanedQuestionText: string;
    answerText: string | null;
    marks: number | null;
    overallConfidence: number;
  };
}

export default async function ReviewPage() {
  const data = await apiGet<{ reviewItems: ReviewItem[] }>("/api/review/tasks").catch(() => ({ reviewItems: [] }));

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">Human review</p>
          <h1>Open review queue</h1>
          <p className="muted">Review tasks include source evidence, reason codes, confidence, and editable extracted fields.</p>
        </div>
      </header>
      <section className="panel">
        <table className="table">
          <thead>
            <tr>
              <th>Severity</th>
              <th>Question</th>
              <th>Type</th>
              <th>Confidence</th>
              <th>Reasons</th>
            </tr>
          </thead>
          <tbody>
            {data.reviewItems.map((item) => (
              <tr key={item.id}>
                <td><span className={`badge ${item.severity.toLowerCase()}`}>{item.severity}</span></td>
                <td>{item.candidate.cleanedQuestionText}</td>
                <td>{item.reviewType}</td>
                <td>{Math.round(item.candidate.overallConfidence * 100)}%</td>
                <td><code>{JSON.stringify(item.reasonCodes)}</code></td>
              </tr>
            ))}
            {data.reviewItems.length === 0 ? (
              <tr>
                <td colSpan={5} className="muted">No open review items.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </>
  );
}

