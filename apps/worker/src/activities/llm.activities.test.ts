import { describe, expect, it } from "vitest";

import { CandidateStatus } from "@queans/db";
import type { ExtractedQuestionCandidate } from "@queans/providers";

import {
  candidateFingerprint,
  questionIdentityFromEvidenceText,
  shouldSkipExistingCandidateForExtraction,
  splitNumberedListCandidate,
  splitSubquestionEvidenceCandidate,
  splitTextSubquestionCandidate
} from "./llm.activities.js";
import { normalizeTaxonomyName } from "./taxonomy.js";

describe("normalizeTaxonomyName", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeTaxonomyName("  Linear   Equations  ")).toBe("Linear Equations");
  });

  it("drops blank taxonomy names", () => {
    expect(normalizeTaxonomyName("   ")).toBeUndefined();
    expect(normalizeTaxonomyName(undefined)).toBeUndefined();
  });
});

describe("candidateFingerprint", () => {
  it("is stable across OCR whitespace and case differences", () => {
    expect(
      candidateFingerprint({
        ...baseCandidate,
        cleanedQuestionText: "  What   Is Photosynthesis?  ",
        questionNumber: " 1 "
      })
    ).toBe(
      candidateFingerprint({
        ...baseCandidate,
        cleanedQuestionText: "what is photosynthesis?",
        questionNumber: "1"
      })
    );
  });

  it("keeps the same text on different pages as separate candidates", () => {
    expect(candidateFingerprint({ ...baseCandidate, pageNumber: 1 })).not.toBe(
      candidateFingerprint({ ...baseCandidate, pageNumber: 2 })
    );
  });

  it("normalizes equivalent single-page source references", () => {
    expect(candidateFingerprint({ ...baseCandidate, pageNumber: 1 })).toBe(
      candidateFingerprint({
        ...baseCandidate,
        pageNumber: undefined,
        sourcePageStart: 1,
        sourcePageEnd: 1
      })
    );
  });

  it("uses question identity over minor OCR text differences when a number exists", () => {
    expect(
      candidateFingerprint({
        ...baseCandidate,
        sectionName: "SECTION D",
        questionNumber: "3(c)",
        cleanedQuestionText: "State two differences between Masa and Weight."
      })
    ).toBe(
      candidateFingerprint({
        ...baseCandidate,
        sectionName: "SECTION D",
        questionNumber: "3(c)",
        cleanedQuestionText: "State two differences between mass and weight."
      })
    );
  });
});

describe("shouldSkipExistingCandidateForExtraction", () => {
  it("preserves committed candidates during later extraction passes", () => {
    expect(
      shouldSkipExistingCandidateForExtraction({
        approvedQuestionId: "question-1",
        reviewStatus: CandidateStatus.EXTRACTED
      })
    ).toBe(true);
  });

  it.each([
    CandidateStatus.APPROVED,
    CandidateStatus.EDITED_AND_APPROVED,
    CandidateStatus.REJECTED,
    CandidateStatus.DUPLICATE,
    CandidateStatus.UNPROCESSABLE
  ])("preserves terminal candidate status %s", (reviewStatus) => {
    expect(
      shouldSkipExistingCandidateForExtraction({
        approvedQuestionId: null,
        reviewStatus
      })
    ).toBe(true);
  });

  it.each([CandidateStatus.EXTRACTED, CandidateStatus.NEEDS_REVIEW])(
    "allows mutable extraction status %s to be refreshed",
    (reviewStatus) => {
      expect(
        shouldSkipExistingCandidateForExtraction({
          approvedQuestionId: null,
          reviewStatus
        })
      ).toBe(false);
    }
  );
});

describe("splitSubquestionEvidenceCandidate", () => {
  it("turns a parent case-study response into grouped answerable parts", () => {
    const parts = splitSubquestionEvidenceCandidate({
      ...baseCandidate,
      questionNumber: "1",
      parentQuestionNumber: "1",
      questionLabel: "Case Study",
      groupKey: "section-d:1",
      stemText: "A boy tries to push a heavy box on the floor.",
      cleanedQuestionText: [
        "Case Study: A boy tries to push a heavy box on the floor.",
        "Answer the following questions:",
        "(a) Which type of friction prevents the box from moving in the beginning?",
        "(b) Which type of friction comes into play once the box starts sliding?"
      ].join("\n"),
      sourceEvidence: {
        subquestions: [
          {
            part_label: "(a)",
            marks: 1,
            answer_text: "Static friction",
            solution_text: "Static friction prevents the box from moving initially."
          },
          {
            part_label: "(b)",
            marks: 1,
            answer_text: "Sliding friction",
            solution_text: "Sliding friction acts once the box starts sliding."
          }
        ]
      }
    });

    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({
      questionNumber: "1(a)",
      parentQuestionNumber: "1",
      questionLabel: "Case Study",
      partLabel: "a",
      groupKey: "section-d:1",
      stemText: "A boy tries to push a heavy box on the floor.",
      cleanedQuestionText: "Which type of friction prevents the box from moving in the beginning?",
      marks: 1,
      answerText: "Static friction",
      validationErrors: []
    });
    expect(parts[1]).toMatchObject({
      questionNumber: "1(b)",
      partLabel: "b",
      cleanedQuestionText: "Which type of friction comes into play once the box starts sliding?",
      answerText: "Sliding friction"
    });
  });

  it("splits PDF structured subparts with bare labels and distributed marks", () => {
    const parts = splitSubquestionEvidenceCandidate({
      ...baseCandidate,
      questionNumber: "IX.ii",
      parentQuestionNumber: "IX",
      questionLabel: "ii",
      groupKey: "IX.ii",
      stemText: "The heating curve of a substance is given below.",
      marks: 3,
      cleanedQuestionText: [
        "The heating curve of a substance is given below.",
        "",
        "a) State the two factors on which the heat absorbed by a body depends.",
        "",
        "b) What do you understand by heat capacity and latent heat of a substance?",
        "",
        "c) Give the mathematical relation between heat capacity and specific heat capacity of a substance."
      ].join("\n"),
      sourceEvidence: {
        subparts: [
          {
            part_label: "a",
            answer_text: "Mass and specific heat capacity.",
            solution_text: "Heat absorbed is Q = m c delta T."
          },
          {
            part_label: "b",
            answer_text: "Heat capacity is heat needed for unit temperature rise; latent heat is heat for state change.",
            solution_text: "Latent heat is absorbed or released without temperature change."
          },
          {
            part_label: "c",
            answer_text: "C = m c",
            solution_text: "Heat capacity equals mass times specific heat capacity."
          }
        ]
      }
    });

    expect(parts).toHaveLength(3);
    expect(parts.map((part) => part.partLabel)).toEqual(["a", "b", "c"]);
    expect(parts.map((part) => part.marks)).toEqual([1, 1, 1]);
    expect(parts[1]).toMatchObject({
      questionNumber: "IX.ii(b)",
      parentQuestionNumber: "IX.ii",
      groupKey: "IX.ii",
      cleanedQuestionText: "What do you understand by heat capacity and latent heat of a substance?",
      answerText: "Heat capacity is heat needed for unit temperature rise; latent heat is heat for state change.",
      validationErrors: []
    });
  });

  it("splits solver sub_questions evidence that uses part keys", () => {
    const parts = splitSubquestionEvidenceCandidate({
      ...baseCandidate,
      questionNumber: "IV.ii",
      parentQuestionNumber: "IV",
      questionLabel: "ii",
      groupKey: "IV.ii",
      stemText: "Study the diagram given below.",
      marks: 4,
      cleanedQuestionText: [
        "Study the diagram given below.",
        "",
        "a) Name the lens LL'.",
        "",
        "b) What are the points O and O' called?"
      ].join("\n"),
      sourceEvidence: {
        sub_questions: [
          {
            part: "a",
            answer_text: "Convex lens.",
            solution_text: "The drawn lens is thicker at the centre."
          },
          {
            part: "b",
            answer_text: "Optical centres.",
            solution_text: "They are the optical centres marked on the lens."
          }
        ]
      }
    });

    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({
      questionNumber: "IV.ii(a)",
      parentQuestionNumber: "IV.ii",
      partLabel: "a",
      groupKey: "IV.ii",
      answerText: "Convex lens.",
      validationErrors: []
    });
  });

  it("uses subquestion cleaned text when the parent text only has the stem", () => {
    const parts = splitSubquestionEvidenceCandidate({
      ...baseCandidate,
      questionNumber: "IX.ii",
      parentQuestionNumber: "IX",
      questionLabel: "ii",
      groupKey: "IX.ii",
      stemText: "The heating curve of a substance is given below.",
      marks: 3,
      cleanedQuestionText: "The heating curve of a substance is given below.",
      sourceEvidence: {
        sub_questions: [
          {
            part_label: "a",
            marks: 1,
            cleaned_question_text: "State the two factors on which the heat absorbed by a body depends.",
            answer_text: "Mass and specific heat capacity.",
            solution_text: "Q = m c delta T."
          },
          {
            part_label: "b",
            marks: 1,
            cleaned_question_text: "What do you understand by heat capacity and latent heat of a substance?",
            answer_text: "Heat capacity is heat per unit temperature rise; latent heat is heat for phase change.",
            solution_text: "Heat capacity changes temperature; latent heat changes state."
          }
        ]
      }
    });

    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({
      questionNumber: "IX.ii(a)",
      cleanedQuestionText: "State the two factors on which the heat absorbed by a body depends.",
      answerText: "Mass and specific heat capacity.",
      marks: 1
    });
  });
});

describe("splitTextSubquestionCandidate", () => {
  it("splits numerical multipart text before solving and preserves parent marks", () => {
    const parts = splitTextSubquestionCandidate({
      ...baseCandidate,
      questionNumber: "VIII.iii",
      parentQuestionNumber: "VIII",
      questionLabel: "iii",
      groupKey: "VIII.iii",
      stemText: "Two resistors of 4 Ω and 6 Ω are connected in parallel.",
      questionType: "NUMERICAL",
      marks: 4,
      answerText: undefined,
      fieldConfidence: {
        question_text: 0.99,
        question_type: 1,
        marks: 1,
        answer_text: 0
      },
      cleanedQuestionText: [
        "Two resistors of 4 Ω and 6 Ω are connected in parallel. Calculate:",
        "",
        "a) The total resistance of the circuit",
        "b) The current through the battery",
        "c) The current through each resistor."
      ].join("\n"),
      sourceEvidence: {
        marks: 4,
        topic: "Electric Circuits"
      }
    });

    expect(parts).toHaveLength(3);
    expect(parts.map((part) => part.questionNumber)).toEqual(["VIII.iii(a)", "VIII.iii(b)", "VIII.iii(c)"]);
    expect(parts.map((part) => part.partLabel)).toEqual(["a", "b", "c"]);
    expect(parts.map((part) => part.marks)).toEqual([4 / 3, 4 / 3, 4 / 3]);
    expect(parts[0]).toMatchObject({
      parentQuestionNumber: "VIII.iii",
      questionLabel: "iii",
      groupKey: "VIII.iii",
      stemText: "Two resistors of 4 Ω and 6 Ω are connected in parallel.",
      cleanedQuestionText: "The total resistance of the circuit",
      validationErrors: ["ANSWER_UNCERTAIN"]
    });
    expect(parts[0]?.sourceEvidence).toMatchObject({
      parent_marks: 4,
      part_label: "a"
    });
  });

  it("splits bullet-prefixed OCR multipart labels", () => {
    const parts = splitTextSubquestionCandidate({
      ...baseCandidate,
      questionNumber: "VI.iii",
      parentQuestionNumber: "VI",
      questionLabel: "iii",
      groupKey: "VI.iii",
      stemText: "For a body dropped from a certain height:",
      questionType: "SHORT_ANSWER",
      marks: 3,
      answerText: undefined,
      cleanedQuestionText: [
        "For a body dropped from a certain height:",
        "  - a) What is its potential energy at the highest point",
        "  - b) What is its kinetic energy at the highest point",
        "  - c) What is its potential energy at the point just before hitting the ground."
      ].join("\n"),
      sourceEvidence: {
        part_marks: {
          a: 1,
          b: 1,
          c: 1
        }
      }
    });

    expect(parts).toHaveLength(3);
    expect(parts.map((part) => part.partLabel)).toEqual(["a", "b", "c"]);
    expect(parts[2]).toMatchObject({
      questionNumber: "VI.iii(c)",
      cleanedQuestionText: "What is its potential energy at the point just before hitting the ground.",
      marks: 1
    });
  });

  it("splits inline multipart labels from a single paragraph", () => {
    const parts = splitTextSubquestionCandidate({
      ...baseCandidate,
      questionNumber: "V.ii",
      questionLabel: "ii",
      groupKey: "V.ii",
      stemText: "A lens produces a virtual image between the object and the lens.",
      questionType: "MULTI_PART",
      marks: 3,
      answerText: undefined,
      cleanedQuestionText:
        "A lens produces a virtual image between the object and the lens. a) Name the lens. b) Draw a ray diagram to show the formation of this image. c) Draw a graph showing the variation in the angle of deviation with angle of incidence at a prism surface.",
      sourceEvidence: {
        source_evidence_text:
          "ii) A lens produces a virtual image between object and the lens (3)\n- a) Name the lens\n- b) Draw a ray diagram to show the formation of this image\n- c) Draw a graph showing the variation in the angle of deviation with angle of incidence at a prism surface."
      }
    });

    expect(parts).toHaveLength(3);
    expect(parts.map((part) => part.cleanedQuestionText)).toEqual([
      "Name the lens.",
      "Draw a ray diagram to show the formation of this image.",
      "Draw a graph showing the variation in the angle of deviation with angle of incidence at a prism surface."
    ]);
  });

  it("splits bundled roman-number groups before part splitting", () => {
    const parts = splitTextSubquestionCandidate({
      ...baseCandidate,
      questionNumber: undefined,
      sectionName: "VII",
      marks: 10,
      answerText: undefined,
      cleanedQuestionText: [
        "i) (3)",
        "a) Define centre of gravity.",
        "b) How does a centripetal force differ from a centrifugal force?",
        "",
        "ii) (3)",
        "a) A boy stands 60 m in front of a wall and claps. Calculate the speed of sound.",
        "b) Explain why a tuning fork sounds louder on a table.",
        "",
        "iii) A man standing 25 m away from a wall produces a sound.",
        "(4)",
        "a) Calculate the time after which he receives the reflected sound.",
        "b) Will the man hear a distinct echo?"
      ].join("\n")
    });

    expect(parts).toHaveLength(3);
    expect(parts.map((part) => part.questionNumber)).toEqual(["VII.i", "VII.ii", "VII.iii"]);
    expect(parts.map((part) => part.marks)).toEqual([3, 3, 4]);
    expect(parts[2]).toMatchObject({
      parentQuestionNumber: "VII",
      questionLabel: "iii",
      groupKey: "VII.iii",
      stemText: "A man standing 25 m away from a wall produces a sound.\n(4)"
    });
  });

  it("splits parent candidates even when the extractor incorrectly assigned part a", () => {
    const parts = splitTextSubquestionCandidate({
      ...baseCandidate,
      questionNumber: "1",
      parentQuestionNumber: "1",
      questionLabel: "Question 1",
      partLabel: "a",
      groupKey: "section_d_1",
      questionType: "LONG_ANSWER",
      marks: 3,
      answerText: undefined,
      rawOcrText: [
        "1. (3 + 2)",
        "   a. Define Energy.",
        "   b. State two examples when a force acting on a body does not do any work."
      ].join("\n"),
      cleanedQuestionText: [
        "a. Define Energy.",
        "",
        "b. State two examples when a force acting on a body does not do any work."
      ].join("\n"),
      sourceEvidence: {
        marks: 3,
        group_key: "section_d_1",
        part_label: "a"
      }
    });

    expect(parts).toHaveLength(2);
    expect(parts.map((part) => part.questionNumber)).toEqual(["1(a)", "1(b)"]);
    expect(parts.map((part) => part.marks)).toEqual([3, 2]);
    expect(parts[1]).toMatchObject({
      parentQuestionNumber: "1",
      partLabel: "b",
      groupKey: "section_d_1",
      cleanedQuestionText: "State two examples when a force acting on a body does not do any work."
    });
  });

  it("keeps roman detail lines inside the alphabetic subpart", () => {
    const parts = splitTextSubquestionCandidate({
      ...baseCandidate,
      questionNumber: "2",
      parentQuestionNumber: "2",
      questionLabel: "Question 2",
      partLabel: "a",
      groupKey: "section_d_2",
      questionType: "LONG_ANSWER",
      marks: 2,
      answerText: undefined,
      rawOcrText: [
        "2. (2+2+1)",
        "   a. Draw a neat and labelled diagram of a clinical thermometer.",
        "   b. What conclusions can be drawn, if the temperature of the patient is",
        "      i. 40 °C",
        "      ii. 35.5 °C?",
        "   c. Why is a clinical thermometer not sterilised in boiling water?"
      ].join("\n"),
      cleanedQuestionText: [
        "a. Draw a neat and labelled diagram of a clinical thermometer.",
        "b. What conclusions can be drawn, if the temperature of the patient is",
        "   i. 40 °C",
        "   ii. 35.5 °C?",
        "c. Why is a clinical thermometer not sterilised in boiling water?"
      ].join("\n")
    });

    expect(parts).toHaveLength(3);
    expect(parts.map((part) => part.questionNumber)).toEqual(["2(a)", "2(b)", "2(c)"]);
    expect(parts.map((part) => part.marks)).toEqual([2, 2, 1]);
    expect(parts[1]?.cleanedQuestionText).toContain("ii. 35.5 °C?");
  });
});

describe("splitNumberedListCandidate", () => {
  it("splits bundled standalone numbered section questions", () => {
    const parts = splitNumberedListCandidate({
      ...baseCandidate,
      questionNumber: "1",
      sectionName: "SECTION G: Name the kind of motion of the events given below:",
      questionType: "SHORT_ANSWER",
      marks: 5,
      answerText: undefined,
      cleanedQuestionText: [
        "1. Name the motion of the earth around the sun. __________",
        "2. Name the motion of the earth about its fixed axis. __________",
        "3. Name the motion in which the axis of rotation passes through a point in the body itself. __________",
        "4. Name the motion in which the axis of revolution passes through a point outside the body. __________",
        "5. Name the path on which earth moves around the sun. __________"
      ].join("\n"),
      sourceEvidence: {
        marks: 5,
        question_number: "1"
      }
    });

    expect(parts).toHaveLength(5);
    expect(parts.map((part) => part.questionNumber)).toEqual(["1", "2", "3", "4", "5"]);
    expect(parts.map((part) => part.marks)).toEqual([1, 1, 1, 1, 1]);
    expect(parts[0]).toMatchObject({
      parentQuestionNumber: undefined,
      groupKey: undefined,
      questionLabel: "Question 1",
      cleanedQuestionText: "Name the motion of the earth around the sun. __________"
    });
  });
});

describe("questionIdentityFromEvidenceText", () => {
  it("reads numeric question labels from MCQ evidence", () => {
    expect(
      questionIdentityFromEvidenceText(
        "7. Which one of the following combinations is the correct ascending order of electromagnetic waves in terms of wavelength?\n(a) gamma-rays"
      )
    ).toEqual({
      questionNumber: "7",
      marks: undefined
    });
  });

  it("reads roman section, part, and marks from section evidence", () => {
    expect(
      questionIdentityFromEvidenceText(
        "II. i. Complete the following by choosing the correct answers from the bracket (6)\n\na) Liver works on the principle of ..."
      )
    ).toEqual({
      questionNumber: "II.i",
      marks: 6
    });
  });

  it("reads roman section labels across line breaks", () => {
    expect(
      questionIdentityFromEvidenceText(
        "IV\n\ni) A lens of focal length 15 cm forms an image on the screen of size three times that of the object. (3)"
      )
    ).toEqual({
      questionNumber: "IV.i",
      marks: 3
    });
  });
});

const baseCandidate = {
  pageNumber: 1,
  rawOcrText: "1. What is photosynthesis?",
  cleanedQuestionText: "What is photosynthesis?",
  questionType: "short_answer",
  marks: 2,
  answerText: "The process by which plants make food.",
  answerSourceType: "SOURCE_KEY",
  answerSourceBacked: true,
  requiresDiagram: false,
  fieldConfidence: {
    question_text: 0.95,
    question_type: 0.94,
    marks: 0.93,
    answer_text: 0.92
  },
  overallConfidence: 0.94,
  validationErrors: [],
  sourceEvidence: {
    page: 1
  }
} satisfies ExtractedQuestionCandidate;
