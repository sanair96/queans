import { describe, expect, it } from "vitest";

import {
  MistralBatchProvider,
  MistralBlueprintLanguageAnalyzer,
  MistralBlueprintRuleExtractor,
  parseMistralExtractionContent,
  parseMistralOcrResult
} from "./mistral.js";

const baseCandidate = {
  raw_ocr_text: "1. What is photosynthesis?",
  cleaned_question_text: "What is photosynthesis?",
  question_type: "short_answer",
  marks: 2,
  answer_text: "The process by which plants make food using light.",
  field_confidence: {
    question_text: 0.96,
    question_type: 0.94,
    marks: 0.9,
    answer_text: 0.93
  },
  overall_confidence: 0.94,
  validation_errors: [],
  source_evidence: {
    page: 1,
    quote: "The process by which plants make food using light."
  }
};

describe("parseMistralExtractionContent", () => {
  it("preserves source-backed answer provenance", () => {
    const [candidate] = parseMistralExtractionContent(
      JSON.stringify({
        candidates: [
          {
            ...baseCandidate,
            answer_source_type: "SOURCE_KEY",
            answer_source_backed: true
          }
        ]
      })
    );

    expect(candidate?.answerSourceType).toBe("SOURCE_KEY");
    expect(candidate?.answerSourceBacked).toBe(true);
  });

  it("defaults missing answer provenance to unverified LLM generation", () => {
    const [candidate] = parseMistralExtractionContent(
      JSON.stringify({
        candidates: [baseCandidate]
      })
    );

    expect(candidate?.answerSourceType).toBe("LLM_GENERATED");
    expect(candidate?.answerSourceBacked).toBe(false);
  });

  it("preserves extracted taxonomy labels", () => {
    const [candidate] = parseMistralExtractionContent(
      JSON.stringify({
        candidates: [
          {
            ...baseCandidate,
            chapter: "Algebra",
            topic: "Linear Equations",
            subtopic: "Pair of Linear Equations"
          }
        ]
      })
    );

    expect(candidate).toMatchObject({
      chapter: "Algebra",
      topic: "Linear Equations",
      subtopic: "Pair of Linear Equations"
    });
  });

  it("preserves subquestion grouping metadata", () => {
    const [candidate] = parseMistralExtractionContent(
      JSON.stringify({
        candidates: [
          {
            ...baseCandidate,
            question_number: "2.a",
            parent_question_number: "2",
            question_label: "Question 2",
            part_label: "a",
            group_key: "section-c:2",
            stem_text: "Observe the circuit diagram and answer the following.",
            display_order: 7
          }
        ]
      })
    );

    expect(candidate).toMatchObject({
      questionNumber: "2.a",
      parentQuestionNumber: "2",
      questionLabel: "Question 2",
      partLabel: "a",
      groupKey: "section-c:2",
      stemText: "Observe the circuit diagram and answer the following.",
      displayOrder: 7
    });
  });

  it("derives stable grouping metadata for real case-study style subquestions", () => {
    const [firstPart, secondPart] = parseMistralExtractionContent(
      JSON.stringify({
        candidates: [
          {
            ...baseCandidate,
            question_number: "21(a)",
            parent_question_number: "21",
            part_label: "a",
            stem_text:
              "A boy tries to push a heavy box on the floor. Initially, he applies less force and the box does not move.",
            cleaned_question_text: "Which type of friction prevents the box from moving in the beginning?",
            marks: 1,
            answer_text: "Static friction",
            field_confidence: {
              question_text: 0.94,
              question_type: 0.9,
              marks: 0.89,
              answer_text: 0.88
            }
          },
          {
            ...baseCandidate,
            question_number: "21(b)",
            parent_question_number: "21",
            part_label: "b",
            stem_text:
              "A boy tries to push a heavy box on the floor. Initially, he applies less force and the box does not move.",
            cleaned_question_text: "Which type of friction comes into play once the box starts sliding?",
            marks: 1,
            answer_text: "Sliding friction",
            field_confidence: {
              question_text: 0.94,
              question_type: 0.9,
              marks: 0.89,
              answer_text: 0.88
            }
          }
        ]
      })
    );

    expect(firstPart).toMatchObject({
      parentQuestionNumber: "21",
      questionLabel: "Question 21",
      partLabel: "a",
      groupKey: "21"
    });
    expect(secondPart).toMatchObject({
      parentQuestionNumber: "21",
      questionLabel: "Question 21",
      partLabel: "b",
      groupKey: "21"
    });
  });

  it("adds review-blocking validation errors for incomplete required question data", () => {
    const [candidate] = parseMistralExtractionContent(
      JSON.stringify({
        candidates: [
          {
            ...baseCandidate,
            question_type: "MCQ",
            marks: undefined,
            options: null,
            answer_text: "   ",
            validation_errors: []
          }
        ]
      })
    );

    expect(candidate?.questionType).toBe("MCQ");
    expect(candidate?.validationErrors).toEqual(["MISSING_MARKS", "MCQ_OPTIONS_MISSING", "ANSWER_UNCERTAIN"]);
  });

  it("normalizes keyed MCQ options before validation", () => {
    const [candidate] = parseMistralExtractionContent(
      JSON.stringify({
        candidates: [
          {
            ...baseCandidate,
            question_type: "MCQ",
            options: {
              a: "Fuel",
              b: "Lubricant",
              c: "Coolant",
              d: "Solvent"
            },
            answer_text: "Lubricant"
          }
        ]
      })
    );

    expect(candidate).toMatchObject({
      questionType: "MCQ",
      options: ["(a) Fuel", "(b) Lubricant", "(c) Coolant", "(d) Solvent"],
      validationErrors: []
    });
  });

  it("normalizes labeled MCQ option objects before validation", () => {
    const [candidate] = parseMistralExtractionContent(
      JSON.stringify({
        candidates: [
          {
            ...baseCandidate,
            question_type: "MCQ",
            options: [
              { label: "(a)", text: "Shape of a body" },
              { label: "(b)", text: "Speed of a body" },
              { label: "(c)", text: "Direction of motion" },
              { label: "(d)", text: "All of these" }
            ],
            answer_text: "(d) All of these"
          }
        ]
      })
    );

    expect(candidate).toMatchObject({
      questionType: "MCQ",
      options: ["(a) Shape of a body", "(b) Speed of a body", "(c) Direction of motion", "(d) All of these"],
      validationErrors: []
    });
  });

  it("preserves diagram asset references", () => {
    const [candidate] = parseMistralExtractionContent(
      JSON.stringify({
        candidates: [
          {
            ...baseCandidate,
            cleaned_question_text: "Three resistors are connected as shown in the figure. Find the current.",
            requires_diagram: true,
            diagram_asset: {
              imageId: "img-1",
              objectKey: "ocr-assets/source/page-1/img-1.png",
              label: "page 1 img-1.png"
            }
          }
        ]
      })
    );

    expect(candidate).toMatchObject({
      requiresDiagram: true,
      diagramAsset: {
        imageId: "img-1",
        objectKey: "ocr-assets/source/page-1/img-1.png",
        label: "page 1 img-1.png"
      }
    });
  });

  it("does not attach a source image to draw-your-own diagram questions", () => {
    const [candidate] = parseMistralExtractionContent(
      JSON.stringify({
        candidates: [
          {
            ...baseCandidate,
            cleaned_question_text:
              "Draw the path of a light ray passing through a prism. Label the angle of incidence and angle of deviation in the ray diagram.",
            requires_diagram: true,
            diagram_asset: {
              imageId: "img-0.jpeg",
              objectKey: "ocr-assets/source/page-3/circuit.jpeg",
              label: "page 3 img-0.jpeg"
            },
            validation_errors: ["DIAGRAM_ASSET_MISSING"]
          }
        ]
      })
    );

    expect(candidate).toMatchObject({
      requiresDiagram: false,
      diagramAsset: undefined,
      validationErrors: []
    });
  });

  it("maps unknown validation warnings to a review-blocking validation failure", () => {
    const [candidate] = parseMistralExtractionContent(
      JSON.stringify({
        candidates: [
          {
            ...baseCandidate,
            validation_errors: ["answer looks guessed", "LOW_TOPIC_CONFIDENCE", "answer looks guessed"]
          }
        ]
      })
    );

    expect(candidate?.validationErrors).toEqual(["VALIDATION_FAILED", "LOW_TOPIC_CONFIDENCE"]);
  });

  it("normalizes out-of-range confidence values to review-blocking failures", () => {
    const [candidate] = parseMistralExtractionContent(
      JSON.stringify({
        candidates: [
          {
            ...baseCandidate,
            field_confidence: {
              question_text: 95,
              answer_text: 0.93
            },
            overall_confidence: 94
          }
        ]
      })
    );

    expect(candidate?.fieldConfidence).toEqual({
      question_text: 0,
      answer_text: 0.93
    });
    expect(candidate?.overallConfidence).toBe(0);
    expect(candidate?.validationErrors).toEqual(["VALIDATION_FAILED"]);
  });

  it("fails malformed extraction responses with a readable parser error", () => {
    expect(() =>
      parseMistralExtractionContent(
        JSON.stringify({
          candidates: [
            {
              field_confidence: {},
              overall_confidence: 0.4,
              validation_errors: [],
              source_evidence: {}
            }
          ]
        })
      )
    ).toThrow("Mistral extraction response did not match the required candidate schema.");
  });
});

describe("parseMistralOcrResult", () => {
  it("normalizes DOCX OCR pages when Mistral returns nullable optional arrays", () => {
    const result = parseMistralOcrResult({
      model: "mistral-ocr-latest",
      pages: [
        {
          index: 0,
          markdown: "Section D: Case Study Based Question\\n(a) Which type of friction prevents the box from moving?",
          images: null,
          blocks: null,
          dimensions: null,
          confidence_scores: null
        }
      ],
      usage_info: {
        pages_processed: 1
      }
    });

    expect(result.pages[0]).toMatchObject({
      pageNumber: 1,
      blocks: [
        {
          blockType: "markdown_page"
        }
      ],
      images: []
    });
    expect(result.pages[0]?.markdown).toContain("Case Study");
    expect(result.pages[0]?.blocks[0]?.text).toContain("Case Study");
    expect(result.usage.pagesProcessed).toBe(1);
  });
});

describe("MistralQuestionExtractor", () => {
  it("requests strict JSON schema output for question candidates", async () => {
    const { MistralQuestionExtractor } = await import("./mistral.js");
    const fetchCalls: unknown[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (_input, init) => {
      const body = init?.body;
      if (typeof body !== "string") {
        throw new Error("Expected Mistral request body to be serialized JSON.");
      }
      fetchCalls.push(JSON.parse(body));
      const responseBody = JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({ candidates: [] })
            }
          }
        ],
        usage: {}
      });
      return Promise.resolve(
        new Response(responseBody, {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        })
      );
    };

    try {
      const extractor = new MistralQuestionExtractor({
        apiKey: "test-key",
        ocrModel: "mistral-ocr-latest",
        extractorModel: "mistral-small-latest",
        segmentationModel: "mistral-small-latest",
        solverModel: "mistral-large-latest"
      });

      await extractor.extractFromPages([
        {
          pageNumber: 1,
          markdown: "1. What is photosynthesis?",
          rawJson: {},
          blocks: [
            {
              blockType: "image",
              text: "img-1.png",
              sourceAsset: {
                imageId: "img-1",
                objectKey: "ocr-assets/source/page-1/img-1.png"
              }
            }
          ],
          images: []
        }
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchCalls[0]).toMatchObject({
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "question_candidates",
          strict: true,
          schema: {
            required: ["candidates"]
          }
        }
      }
    });

    const request = asRecord(fetchCalls[0]);
    const responseFormat = asRecord(request.response_format);
    const jsonSchema = asRecord(responseFormat.json_schema);
    const schema = asRecord(jsonSchema.schema);
    const schemaProperties = asRecord(schema.properties);
    const candidates = asRecord(schemaProperties.candidates);
    const candidateItems = asRecord(candidates.items);
    const candidateProperties = asRecord(candidateItems.properties);
    const fieldConfidence = asRecord(candidateProperties.field_confidence);
    const fieldConfidenceValues = asRecord(fieldConfidence.additionalProperties);
    expect(fieldConfidenceValues).toMatchObject({
      minimum: 0,
      maximum: 1
    });
    expect(candidateProperties.overall_confidence).toMatchObject({
      minimum: 0,
      maximum: 1
    });
    const validationErrors = asRecord(candidateProperties.validation_errors);
    const validationItems = asRecord(validationErrors.items);
    expect(validationItems.enum).toEqual(expect.arrayContaining(["VALIDATION_FAILED", "LOW_TOPIC_CONFIDENCE"]));
    expect(candidateProperties).toMatchObject({
      parent_question_number: { type: "string" },
      question_label: { type: "string" },
      part_label: { type: "string" },
      group_key: { type: "string" },
      stem_text: { type: "string" },
      display_order: { type: "integer" }
    });
    const messages = request.messages as Array<{ role: string; content: string }>;
    expect(messages[1]?.content).toContain("Image assets on this page:");
    expect(messages[1]?.content).toContain("ocr-assets/source/page-1/img-1.png");
  });

  it("instructs the solver to compute numerical answers and avoid unnecessary answer review flags", async () => {
    const { MistralQuestionExtractor } = await import("./mistral.js");
    const fetchCalls: unknown[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (_input, init) => {
      const body = init?.body;
      if (typeof body !== "string") {
        throw new Error("Expected Mistral request body to be serialized JSON.");
      }
      fetchCalls.push(JSON.parse(body));
      const responseBody = JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                candidate: {
                  ...baseCandidate,
                  answer_source_type: "LLM_GENERATED",
                  answer_source_backed: false
                }
              })
            }
          }
        ],
        usage: {}
      });
      return Promise.resolve(
        new Response(responseBody, {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        })
      );
    };

    try {
      const extractor = new MistralQuestionExtractor({
        apiKey: "test-key",
        ocrModel: "mistral-ocr-latest",
        extractorModel: "mistral-small-latest",
        segmentationModel: "mistral-small-latest",
        solverModel: "mistral-large-latest"
      });

      await extractor.solveCandidate(
        {
          rawOcrText:
            "A wooden block is pressed with a force of 50 N on the ground. If the contact area is 0.25 m², calculate the pressure.",
          cleanedQuestionText:
            "A wooden block is pressed with a force of 50 N on the ground. If the contact area is 0.25 m², calculate the pressure.",
          questionType: "NUMERICAL",
          marks: 3,
          answerSourceType: "LLM_GENERATED",
          answerSourceBacked: false,
          requiresDiagram: false,
          fieldConfidence: {
            question_text: 0.99,
            question_type: 1,
            marks: 1
          },
          overallConfidence: 0.96,
          validationErrors: ["ANSWER_UNCERTAIN"],
          sourceEvidence: {}
        },
        []
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    const request = asRecord(fetchCalls[0]);
    const messages = request.messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.content).toContain("For numerical questions, compute the answer");
    expect(messages[0]?.content).toContain("Do not add ANSWER_UNCERTAIN or LLM_GENERATED_ANSWER_UNVERIFIED");
  });
});

describe("MistralBlueprintLanguageAnalyzer", () => {
  it("requests generic multilingual analysis with page-level language evidence", async () => {
    const fetchCalls: unknown[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (_input, init) => {
      const body = init?.body;
      if (typeof body !== "string") {
        throw new Error("Expected Mistral request body to be serialized JSON.");
      }
      fetchCalls.push(JSON.parse(body));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    detected_languages: [
                      { tag: "en", confidence: 0.99, page_numbers: [1] },
                      { tag: "hi", confidence: 0.99, page_numbers: [2] }
                    ],
                    primary_language: { tag: "hi", confidence: 0.96 },
                    mixed_language_page_numbers: [],
                    multilingual_relationship: "DUPLICATE_TRANSLATIONS",
                    page_languages: [
                      { page_number: 1, languages: [{ tag: "en", confidence: 0.99 }] },
                      { page_number: 2, languages: [{ tag: "hi", confidence: 0.99 }] }
                    ],
                    document_analysis: {
                      is_marking_scheme: true,
                      confidence: 0.98,
                      title_language_tag: "hi",
                      header_language_tag: "hi",
                      evidence_page_numbers: [1, 2],
                      evaluator_instruction_page_numbers: [1],
                      marking_scheme_page_numbers: [2],
                      paper_code: "3/8/1"
                    }
                  })
                }
              }
            ],
            usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    };

    try {
      const analyzer = new MistralBlueprintLanguageAnalyzer(testMistralConfig);
      const result = await analyzer.analyzePages({
        pages: [
          { pageNumber: 1, markdown: "# Question Paper" },
          { pageNumber: 2, markdown: "# प्रश्न पत्र" }
        ]
      });
      expect(result).toMatchObject({
        primaryLanguage: { tag: "hi", confidence: 0.96 },
        multilingualRelationship: "DUPLICATE_TRANSLATIONS"
      });
      expect(result.pageLanguages[0]).toMatchObject({ pageNumber: 1, languages: [{ tag: "en" }] });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const request = asRecord(fetchCalls[0]);
    expect(request.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "blueprint_language_analysis", strict: true }
    });
    const messages = request.messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.content).toContain("every language present");
    expect(messages[1]?.content).toContain("Page 2:\n# प्रश्न पत्र");
  });
});

describe("MistralBlueprintRuleExtractor", () => {
  it("requires strict marking-scheme JSON and source references", async () => {
    const fetchCalls: unknown[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (_input, init) => {
      const body = init?.body;
      if (typeof body !== "string") {
        throw new Error("Expected Mistral request body to be serialized JSON.");
      }
      fetchCalls.push(JSON.parse(body));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    rules: { document_metadata: { title: null, subject: "Hindi", examination: null, paper_code: "2/8/2", session: null, total_marks: 10, source_pages: [1] }, evaluation_rules: [{ rule: "सभी प्रश्नों के उत्तर दीजिए", source_pages: [1] }], assessment_blueprint: { sections: [{ name: "खंड अ", question_range: "1", question_type: null, choice_rules: [], declared_marks: 10, source_pages: [1] }], total_marks: 10, source_pages: [1] }, question_marking_scheme: [{ number: "1", section: "खंड अ", marks: 10, parts: [], alternatives: [], value_points: [], acceptable_answers: [], marking_notes: [], source_pages: [1] }] },
                    confidence: 0.91,
                    source_references: [{ page_number: 1, language_tag: "hi", snippet: "सभी प्रश्नों" }],
                    warnings: []
                  })
                }
              }
            ],
            usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    };

    try {
      const extractor = new MistralBlueprintRuleExtractor(testMistralConfig);
      await expect(
        extractor.extractRules({ primaryLanguage: "hi", pages: [{ pageNumber: 1, markdown: "# खंड अ\nसभी प्रश्नों" }] })
      ).resolves.toMatchObject({
        rules: { document_metadata: { paper_code: "2/8/2" }, question_marking_scheme: [{ number: "1", marks: 10 }] },
        sourceReferences: [{ pageNumber: 1, languageTag: "hi" }]
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const request = asRecord(fetchCalls[0]);
    expect(request.response_format).toMatchObject({
      type: "json_schema",
      json_schema: {
        name: "blueprint_extraction",
        strict: true,
        schema: { required: ["rules", "confidence", "source_references", "warnings"] }
      }
    });
    const messages = request.messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.content).toContain("marking scheme");
    expect(messages[1]?.content).toContain("Designated primary language: hi");
  });
});

describe("MistralBatchProvider", () => {
  it("builds OCR batch lines with image and confidence extraction enabled", () => {
    const provider = new MistralBatchProvider(testMistralConfig);

    expect(
      provider.buildOcrBatchLine({
        customId: "sourcePaper:source-1",
        documentUrl: "https://r2.example/source.pdf"
      })
    ).toEqual({
      custom_id: "sourcePaper:source-1",
      body: {
        confidence_scores_granularity: "word",
        table_format: "markdown",
        include_image_base64: true,
        document: {
          type: "document_url",
          document_url: "https://r2.example/source.pdf"
        }
      }
    });
  });

  it("normalizes OCR images separately from sanitized page raw JSON", () => {
    const result = parseMistralOcrResult({
      model: "mistral-ocr-latest",
      usage_info: {
        pages_processed: 1,
        doc_size_bytes: 123
      },
      pages: [
        {
          index: 0,
          markdown: "![diagram](img-1.png)",
          images: [
            {
              id: "img-1",
              image_base64: "data:image/png;base64,aGVsbG8=",
              top_left_x: 1,
              top_left_y: 2,
              bottom_right_x: 3,
              bottom_right_y: 4
            }
          ],
          dimensions: {
            width: 100,
            height: 200,
            dpi: 200
          }
        }
      ]
    });

    const image = result.pages[0]?.images[0];
    expect(image?.id).toBe("img-1");
    expect(image?.fileName).toBe("img-1.png");
    expect(image?.mimeType).toBe("image/png");
    expect(image?.base64).toBe("aGVsbG8=");
    expect(image?.boundingBox).toEqual({
      top_left_x: 1,
      top_left_y: 2,
      bottom_right_x: 3,
      bottom_right_y: 4
    });
    expect(image?.rawJson).toMatchObject({
      image_base64: "[stored-in-r2]"
    });
    expect(result.pages[0]?.rawJson).toMatchObject({
      images: [
        {
          image_base64: "[stored-in-r2]"
        }
      ]
    });
  });
});

const testMistralConfig = {
  apiKey: "test-key",
  ocrModel: "mistral-ocr-latest",
  extractorModel: "mistral-small-latest",
  segmentationModel: "mistral-small-latest",
  solverModel: "mistral-large-latest"
};

function asRecord(value: unknown) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected object record.");
  }

  return value as Record<string, unknown>;
}
