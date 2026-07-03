import { apiGet } from "../api-client";
import { ReviewWorkbench } from "./review-workbench";

interface ReviewItem {
  id: string;
  reviewType: string;
  severity: string;
  reasonCodes: unknown;
  status: string;
  createdAt: string;
  reviewPayload: unknown;
  sourceImages?: unknown;
  sourcePaper: {
    sourceFileName: string;
  };
  candidate: {
    id: string;
    questionNumber: string | null;
    questionType: string;
    rawOcrText: string;
    cleanedQuestionText: string;
    answerText: string | null;
    options: unknown;
    diagramAsset: unknown;
    solutionText: string | null;
    difficulty: string | null;
    marks: number | null;
    overallConfidence: number;
    fieldConfidence: unknown;
    sourceEvidence: unknown;
  };
}

export default async function ReviewPage() {
  const data = await loadReviewItems();

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">Human review</p>
          <h1>Open review queue</h1>
        </div>
      </header>
      {data.error ? (
        <section className="panel empty-state">
          <strong>{data.error}</strong>
        </section>
      ) : (
        <ReviewWorkbench initialItems={data.reviewItems} />
      )}
    </>
  );
}

async function loadReviewItems() {
  try {
    const data = await apiGet<{ reviewItems: ReviewItem[] }>("/api/review/tasks");
    return { reviewItems: data.reviewItems, error: undefined };
  } catch (error) {
    return {
      reviewItems: [],
      error: error instanceof Error ? error.message : "Review queue failed to load."
    };
  }
}
