import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiGet } from "../api-client";
import QuestionsPage from "./page";

vi.mock("../api-client", () => ({
  apiGet: vi.fn()
}));

vi.stubGlobal("React", React);

const mockedApiGet = vi.mocked(apiGet);

describe("QuestionsPage", () => {
  beforeEach(() => {
    mockedApiGet.mockReset();
  });

  it("shows the load error instead of the empty question-bank state", async () => {
    mockedApiGet.mockRejectedValue(new Error("API request failed: database unavailable"));

    const html = renderToStaticMarkup(await QuestionsPage());

    expect(mockedApiGet).toHaveBeenCalledWith("/api/questions");
    expect(html).toContain("API request failed: database unavailable");
    expect(html).not.toContain("No approved questions yet.");
  });

  it("renders grouped subquestions with answers and diagram images", async () => {
    mockedApiGet.mockResolvedValue({
      questions: [
        {
          id: "question-2b",
          questionText: "Find the current through the 10 ohm resistor.",
          questionType: "NUMERICAL",
          marks: 2,
          options: null,
          parentQuestionNumber: "2",
          questionLabel: "Question 2",
          partLabel: "b",
          groupKey: "section-e:2",
          stemText: "Observe the circuit diagram and answer the following.",
          displayOrder: 2,
          requiresDiagram: true,
          diagramAsset: {
            imageId: "img-1",
            label: "Circuit diagram",
            url: "https://r2.example/circuit.png"
          },
          sourceEvidence: {
            page: 3
          },
          answers: [{ answerText: "1 A", solutionText: null, sourceType: "LLM_GENERATED", reviewStatus: "APPROVED" }],
          chapter: null,
          topic: { name: "Electricity" },
          subtopic: null,
          sourcePaper: { sourceFileName: "physics.pdf", title: "Physics paper" }
        },
        {
          id: "question-2a",
          questionText: "Name the type of circuit shown.",
          questionType: "SHORT_ANSWER",
          marks: 1,
          options: null,
          parentQuestionNumber: "2",
          questionLabel: "Question 2",
          partLabel: "a",
          groupKey: "section-e:2",
          stemText: "Observe the circuit diagram and answer the following.",
          displayOrder: 1,
          requiresDiagram: true,
          diagramAsset: null,
          sourceEvidence: {
            page: 3
          },
          answers: [{ answerText: "Parallel circuit", solutionText: null, sourceType: "SOURCE_KEY", reviewStatus: "APPROVED" }],
          chapter: null,
          topic: { name: "Electricity" },
          subtopic: null,
          sourcePaper: { sourceFileName: "physics.pdf", title: "Physics paper" }
        }
      ]
    });

    const html = renderToStaticMarkup(await QuestionsPage());

    expect(html).toContain("Observe the circuit diagram and answer the following.");
    expect(html.indexOf("Name the type of circuit shown.")).toBeLessThan(html.indexOf("Find the current"));
    expect(html).toContain("Parallel circuit");
    expect(html).toContain("1 A");
    expect(html).toContain("https://r2.example/circuit.png");
    expect(html).toContain("Circuit diagram");
  });

  it("does not group standalone questions just because model group keys collide", async () => {
    mockedApiGet.mockResolvedValue({
      questions: [
        {
          id: "assertion-1",
          questionText: "Assertion: The apparent depth of a coin is less than its real depth.",
          questionType: "MCQ",
          marks: 1,
          options: null,
          parentQuestionNumber: null,
          questionLabel: null,
          partLabel: null,
          groupKey: "1",
          stemText: null,
          displayOrder: 1,
          requiresDiagram: false,
          diagramAsset: null,
          sourceEvidence: {},
          answers: [{ answerText: "A", solutionText: null, sourceType: "SOURCE_KEY", reviewStatus: "APPROVED" }],
          chapter: null,
          topic: null,
          subtopic: null,
          sourcePaper: { sourceFileName: "physics.pdf", title: null }
        },
        {
          id: "question-1",
          questionText: "Account for the following.",
          questionType: "SHORT_ANSWER",
          marks: 6,
          options: null,
          parentQuestionNumber: "1",
          questionLabel: "Question 1",
          partLabel: null,
          groupKey: "1",
          stemText: "Account for the following.",
          displayOrder: 1,
          requiresDiagram: false,
          diagramAsset: null,
          sourceEvidence: {},
          answers: [{ answerText: "Explanation", solutionText: null, sourceType: "LLM_GENERATED", reviewStatus: "APPROVED" }],
          chapter: null,
          topic: null,
          subtopic: null,
          sourcePaper: { sourceFileName: "physics.pdf", title: null }
        }
      ]
    });

    const html = renderToStaticMarkup(await QuestionsPage());

    expect(html).toContain("Assertion: The apparent depth");
    expect(html).toContain("Account for the following.");
    expect(html).not.toContain("2 parts");
  });
});
