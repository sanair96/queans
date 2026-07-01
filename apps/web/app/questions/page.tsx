import { apiGet } from "../api-client";

interface Question {
  id: string;
  questionText: string;
  questionType: string;
  marks: number | null;
  difficulty: string | null;
  answers: Array<{ answerText: string; sourceType: string; reviewStatus: string }>;
  topic: { name: string } | null;
}

export default async function QuestionsPage() {
  const data = await loadQuestions();

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">Question bank</p>
          <h1>Approved questions</h1>
          <p className="muted">Only approved or edited-and-approved candidates are committed here.</p>
        </div>
      </header>
      <section className="panel">
        <table className="table">
          <thead>
            <tr>
              <th>Question</th>
              <th>Type</th>
              <th>Marks</th>
              <th>Topic</th>
              <th>Answer source</th>
            </tr>
          </thead>
          <tbody>
            {data.error ? (
              <tr>
                <td colSpan={5} className="muted">{data.error}</td>
              </tr>
            ) : null}
            {!data.error ? data.questions.map((question) => (
              <tr key={question.id}>
                <td>{question.questionText}</td>
                <td>{question.questionType}</td>
                <td>{question.marks ?? "-"}</td>
                <td>{question.topic?.name ?? "-"}</td>
                <td>{question.answers[0]?.sourceType ?? "-"}</td>
              </tr>
            )) : null}
            {!data.error && data.questions.length === 0 ? (
              <tr>
                <td colSpan={5} className="muted">No approved questions yet.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </>
  );
}

async function loadQuestions() {
  try {
    const data = await apiGet<{ questions: Question[] }>("/api/questions");
    return { questions: data.questions, error: undefined };
  } catch (error) {
    return {
      questions: [],
      error: error instanceof Error ? error.message : "Questions failed to load."
    };
  }
}
