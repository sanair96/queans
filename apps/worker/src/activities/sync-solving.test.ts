import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const tx = {
    questionCandidate: {
      findUnique: vi.fn(),
      update: vi.fn()
    },
    candidateFieldConfidence: {
      deleteMany: vi.fn(),
      createMany: vi.fn()
    },
    providerRunCost: {
      upsert: vi.fn()
    }
  };

  return {
    tx,
    extractor: {
      solveCandidate: vi.fn()
    },
    r2: {
      readObject: vi.fn()
    },
    prisma: {
      questionCandidate: {
        findMany: vi.fn(),
        updateMany: vi.fn()
      },
      ocrBlock: {
        findMany: vi.fn()
      },
      providerBatchJob: {
        create: vi.fn()
      },
      $transaction: vi.fn()
    }
  };
});

vi.mock("@queans/db", () => ({
  CandidateStatus: {
    EXTRACTED: "EXTRACTED",
    NEEDS_REVIEW: "NEEDS_REVIEW",
    APPROVED: "APPROVED",
    EDITED_AND_APPROVED: "EDITED_AND_APPROVED",
    REJECTED: "REJECTED",
    DUPLICATE: "DUPLICATE",
    UNPROCESSABLE: "UNPROCESSABLE"
  },
  QuestionType: {
    SHORT_ANSWER: "SHORT_ANSWER",
    MCQ: "MCQ",
    LONG_ANSWER: "LONG_ANSWER",
    NUMERICAL: "NUMERICAL",
    TRUE_FALSE: "TRUE_FALSE",
    FILL_IN_THE_BLANK: "FILL_IN_THE_BLANK",
    MATCHING: "MATCHING",
    DIAGRAM: "DIAGRAM",
    UNKNOWN: "UNKNOWN"
  },
  ReviewReason: {
    LOW_ANSWER_CONFIDENCE: "LOW_ANSWER_CONFIDENCE",
    LOW_TOPIC_CONFIDENCE: "LOW_TOPIC_CONFIDENCE",
    LOW_FIELD_CONFIDENCE: "LOW_FIELD_CONFIDENCE"
  },
  Prisma: {
    JsonNull: null
  },
  prisma: mocks.prisma
}));

vi.mock("@queans/providers", () => ({
  createQuestionExtractorFromEnv: vi.fn(() => mocks.extractor),
  loadMistralConfigFromEnv: vi.fn(() => ({
    apiKey: "test-key",
    ocrModel: "mistral-ocr-latest",
    extractorModel: "mistral-small-latest",
    segmentationModel: "mistral-small-latest",
    solverModel: "mistral-large-latest"
  })),
  loadR2ConfigFromEnv: vi.fn(() => ({
    accountId: "account",
    accessKeyId: "key",
    secretAccessKey: "secret",
    bucket: "bucket",
    endpoint: "https://account.r2.cloudflarestorage.com",
    region: "auto",
    presignExpiresSeconds: 900
  })),
  maxR2PresignExpiresSeconds: 604800,
  MistralBatchProvider: class {},
  R2ObjectStore: class {
    createPresignedRead() {
      return Promise.resolve("https://r2.example/asset.png");
    }

    async readObject(objectKey: string): Promise<{ objectKey: string; body: Uint8Array; contentType?: string | undefined }> {
      return (await mocks.r2.readObject(objectKey)) as {
        objectKey: string;
        body: Uint8Array;
        contentType?: string | undefined;
      };
    }
  },
  parseMistralChatCandidateBatchBody: vi.fn(),
  parseMistralExtractionContent: vi.fn(),
  parseMistralSolvingContent: vi.fn()
}));

const { solveQuestionsAndPersist } = await import("./llm.activities.js");

describe("solveQuestionsAndPersist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MISTRAL_SOLVER_CONCURRENCY;
    delete process.env.MISTRAL_SOLVER_REQUEST_INTERVAL_MS;
    mocks.prisma.$transaction.mockImplementation(async (callback: (tx: typeof mocks.tx) => Promise<unknown>) =>
      callback(mocks.tx)
    );
    mocks.prisma.ocrBlock.findMany.mockResolvedValue([]);
    mocks.r2.readObject.mockResolvedValue({
      objectKey: "ocr-assets/source-1/page-1/image.png",
      body: Uint8Array.from([104, 105]),
      contentType: "image/png"
    });
    mocks.tx.questionCandidate.findUnique.mockResolvedValue(candidateRow);
    mocks.tx.questionCandidate.update.mockResolvedValue({ id: "candidate-1" });
    mocks.tx.candidateFieldConfidence.deleteMany.mockResolvedValue({ count: 0 });
    mocks.tx.candidateFieldConfidence.createMany.mockResolvedValue({ count: 1 });
    mocks.tx.providerRunCost.upsert.mockResolvedValue({ id: "cost-1" });
  });

  it("solves candidates synchronously, records non-discounted cost, and does not create provider batch jobs", async () => {
    mocks.prisma.questionCandidate.findMany.mockResolvedValue([candidateRow]);
    mocks.extractor.solveCandidate.mockResolvedValue({
      provider: "mistral",
      model: "mistral-large-latest",
      candidate: solvedCandidate,
      rawJson: { id: "completion-1" },
      usage: {
        promptTokens: 1000,
        completionTokens: 500,
        totalTokens: 1500
      }
    });

    await expect(
      solveQuestionsAndPersist({
        ingestionRunId: "run-1",
        sourcePaperId: "source-1"
      })
    ).resolves.toMatchObject({
      candidatesSubmitted: 1,
      candidatesSolved: 1,
      candidatesFailed: 0,
      model: "mistral-large-latest"
    });

    expect(mocks.extractor.solveCandidate).toHaveBeenCalledOnce();
    expect(mocks.tx.questionCandidate.update).toHaveBeenCalledOnce();
    expect(mocks.prisma.providerBatchJob.create).not.toHaveBeenCalled();
    expect(mocks.tx.providerRunCost.upsert).toHaveBeenCalledWith({
      where: {
        workflowRunId_operation: {
          workflowRunId: "run-1",
          operation: "question_solving"
        }
      },
      create: {
        workflowRunId: "run-1",
        operation: "question_solving",
        provider: "mistral",
        model: "mistral-large-latest",
        pageCount: null,
        inputTokenCount: 1000,
        outputTokenCount: 500,
        estimatedCostUsd: "0.000450",
        rawUsage: {
          promptTokens: 1000,
          completionTokens: 500,
          totalTokens: 1500,
          synchronous: true,
          candidatesSubmitted: 1,
          candidatesSolved: 1,
          candidatesFailed: 0,
          solverConcurrency: 1,
          batchDiscountRatio: 1
        }
      },
      update: {
        provider: "mistral",
        model: "mistral-large-latest",
        pageCount: null,
        inputTokenCount: 1000,
        outputTokenCount: 500,
        estimatedCostUsd: "0.000450",
        rawUsage: {
          promptTokens: 1000,
          completionTokens: 500,
          totalTokens: 1500,
          synchronous: true,
          candidatesSubmitted: 1,
          candidatesSolved: 1,
          candidatesFailed: 0,
          solverConcurrency: 1,
          batchDiscountRatio: 1
        }
      }
    });
  });

  it("passes stored OCR diagram images as model-readable data URLs", async () => {
    mocks.prisma.questionCandidate.findMany.mockResolvedValue([
      {
        ...candidateRow,
        requiresDiagram: true,
        diagramAsset: { objectKey: "ocr-assets/source-1/page-1/image.png" }
      }
    ]);
    mocks.prisma.ocrBlock.findMany.mockResolvedValue([
      {
        text: "img-0 circuit diagram",
        sourceAsset: {
          objectKey: "ocr-assets/source-1/page-1/image.png",
          mimeType: "image/png"
        },
        ocrPage: {
          pageNumber: 1
        }
      }
    ]);
    mocks.extractor.solveCandidate.mockResolvedValue({
      provider: "mistral",
      model: "mistral-large-latest",
      candidate: {
        ...solvedCandidate,
        requiresDiagram: true,
        diagramAsset: { objectKey: "ocr-assets/source-1/page-1/image.png" }
      },
      rawJson: { id: "completion-1" },
      usage: {
        promptTokens: 1000,
        completionTokens: 500,
        totalTokens: 1500
      }
    });

    await solveQuestionsAndPersist({
      ingestionRunId: "run-1",
      sourcePaperId: "source-1"
    });

    expect(mocks.r2.readObject).toHaveBeenCalledWith("ocr-assets/source-1/page-1/image.png");
    expect(mocks.extractor.solveCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        requiresDiagram: true
      }),
      [
        {
          label: "page 1 img-0 circuit diagram",
          url: "data:image/png;base64,aGk="
        }
      ]
    );
  });

  it("preserves extracted grouping, marks, and options when the solver only adds the answer", async () => {
    const multipartCandidate = {
      ...candidateRow,
      parentQuestionNumber: "21",
      questionLabel: "Question 21",
      partLabel: "a",
      groupKey: "section-d:21",
      stemText: "A boy tries to push a heavy box on the floor.",
      questionType: "MCQ",
      marks: 1,
      options: ["Static friction", "Sliding friction", "Rolling friction", "Fluid friction"],
      validationErrors: ["ANSWER_UNCERTAIN"]
    };
    mocks.prisma.questionCandidate.findMany.mockResolvedValue([multipartCandidate]);
    mocks.tx.questionCandidate.findUnique.mockResolvedValue(multipartCandidate);
    mocks.extractor.solveCandidate.mockResolvedValue({
      provider: "mistral",
      model: "mistral-large-latest",
      candidate: {
        ...solvedCandidate,
        parentQuestionNumber: undefined,
        questionLabel: undefined,
        partLabel: undefined,
        groupKey: undefined,
        stemText: undefined,
        questionType: "UNKNOWN",
        marks: undefined,
        options: undefined,
        answerText: "Static friction",
        validationErrors: ["MISSING_MARKS", "MCQ_OPTIONS_MISSING"]
      },
      rawJson: { id: "completion-1" },
      usage: {
        promptTokens: 1000,
        completionTokens: 500,
        totalTokens: 1500
      }
    });

    await solveQuestionsAndPersist({
      ingestionRunId: "run-1",
      sourcePaperId: "source-1"
    });

    const updatePayload = mocks.tx.questionCandidate.update.mock.calls[0]?.[0] as
      | { where: { id: string }; data: Record<string, unknown> }
      | undefined;
    expect(updatePayload).toBeDefined();
    expect(updatePayload?.where).toEqual({ id: "candidate-1" });
    expect(updatePayload?.data).toMatchObject({
      parentQuestionNumber: "21",
      questionLabel: "Question 21",
      partLabel: "a",
      groupKey: "section-d:21",
      stemText: "A boy tries to push a heavy box on the floor.",
      questionType: "MCQ",
      marks: 1,
      options: ["Static friction", "Sliding friction", "Rolling friction", "Fluid friction"],
      answerText: "Static friction",
      validationErrors: ["ANSWER_UNCERTAIN"]
    });
  });

  it("promotes source-evidence marks and answers from partial solver responses", async () => {
    const fillBlankCandidate = {
      ...candidateRow,
      cleanedQuestionText: "The force acting per unit area is called __________.",
      questionType: "FILL_IN_THE_BLANK",
      marks: null,
      answerText: null,
      validationErrors: ["MISSING_MARKS", "ANSWER_UNCERTAIN"]
    };
    mocks.prisma.questionCandidate.findMany.mockResolvedValue([fillBlankCandidate]);
    mocks.tx.questionCandidate.findUnique.mockResolvedValue(fillBlankCandidate);
    mocks.extractor.solveCandidate.mockResolvedValue({
      provider: "mistral",
      model: "mistral-large-latest",
      candidate: {
        ...solvedCandidate,
        cleanedQuestionText: "The force acting per unit area is called __________.",
        questionType: "FILL_IN_THE_BLANK",
        marks: undefined,
        answerText: undefined,
        answerSourceType: "SOURCE_KEY",
        answerSourceBacked: true,
        fieldConfidence: {
          question_text: 0.99,
          question_type: 1,
          marks: 1,
          answer_text: 1
        },
        validationErrors: ["MISSING_MARKS", "ANSWER_UNCERTAIN"],
        sourceEvidence: {
          marks: 1,
          answer_text: "Pressure",
          question_number: "1",
          section_name: "Section B: Fill in the blanks (5 x 1 = 5 marks)"
        }
      },
      rawJson: { id: "completion-1" },
      usage: {
        promptTokens: 1000,
        completionTokens: 500,
        totalTokens: 1500
      }
    });

    await solveQuestionsAndPersist({
      ingestionRunId: "run-1",
      sourcePaperId: "source-1"
    });

    const updatePayload = mocks.tx.questionCandidate.update.mock.calls[0]?.[0] as
      | { where: { id: string }; data: Record<string, unknown> }
      | undefined;
    expect(updatePayload?.data).toMatchObject({
      marks: 1,
      answerText: "Pressure",
      answerSourceType: "SOURCE_KEY",
      answerSourceBacked: true,
      sectionName: "Section B: Fill in the blanks (5 x 1 = 5 marks)",
      validationErrors: []
    });
  });

  it("solves candidates concurrently when local solver concurrency is configured", async () => {
    process.env.MISTRAL_SOLVER_CONCURRENCY = "2";
    process.env.MISTRAL_SOLVER_REQUEST_INTERVAL_MS = "0";
    mocks.prisma.questionCandidate.findMany.mockResolvedValue([
      candidateRow,
      {
        ...candidateRow,
        id: "candidate-2",
        questionNumber: "2",
        cleanedQuestionText: "Define pressure."
      }
    ]);

    let inFlight = 0;
    let maxInFlight = 0;
    mocks.extractor.solveCandidate.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return {
        provider: "mistral",
        model: "mistral-large-latest",
        candidate: solvedCandidate,
        rawJson: { id: "completion-1" },
        usage: {
          promptTokens: 1000,
          completionTokens: 500,
          totalTokens: 1500
        }
      };
    });

    await expect(
      solveQuestionsAndPersist({
        ingestionRunId: "run-1",
        sourcePaperId: "source-1"
      })
    ).resolves.toMatchObject({
      candidatesSubmitted: 2,
      candidatesSolved: 2,
      candidatesFailed: 0
    });

    expect(maxInFlight).toBe(2);
    expect(mocks.extractor.solveCandidate).toHaveBeenCalledTimes(2);
    expect(mocks.tx.providerRunCost.upsert).toHaveBeenCalledWith({
      where: {
        workflowRunId_operation: {
          workflowRunId: "run-1",
          operation: "question_solving"
        }
      },
      create: {
        workflowRunId: "run-1",
        operation: "question_solving",
        provider: "mistral",
        model: "mistral-large-latest",
        pageCount: null,
        inputTokenCount: 2000,
        outputTokenCount: 1000,
        estimatedCostUsd: "0.000900",
        rawUsage: {
          promptTokens: 2000,
          completionTokens: 1000,
          totalTokens: 3000,
          synchronous: true,
          candidatesSubmitted: 2,
          candidatesSolved: 2,
          candidatesFailed: 0,
          solverConcurrency: 2,
          batchDiscountRatio: 1
        }
      },
      update: {
        provider: "mistral",
        model: "mistral-large-latest",
        pageCount: null,
        inputTokenCount: 2000,
        outputTokenCount: 1000,
        estimatedCostUsd: "0.000900",
        rawUsage: {
          promptTokens: 2000,
          completionTokens: 1000,
          totalTokens: 3000,
          synchronous: true,
          candidatesSubmitted: 2,
          candidatesSolved: 2,
          candidatesFailed: 0,
          solverConcurrency: 2,
          batchDiscountRatio: 1
        }
      }
    });
  });
});

const candidateRow = {
  id: "candidate-1",
  sourcePaperId: "source-1",
  questionNumber: "1",
  sectionName: null,
  pageNumber: 1,
  sourcePageStart: null,
  sourcePageEnd: null,
  parentQuestionNumber: null,
  questionLabel: null,
  partLabel: null,
  groupKey: null,
  stemText: null,
  displayOrder: null,
  rawOcrText: "1. Define force.",
  cleanedQuestionText: "Define force.",
  questionType: "SHORT_ANSWER",
  marks: 2,
  options: null,
  answerText: null,
  solutionText: null,
  answerSourceType: "LLM_GENERATED",
  answerSourceBacked: false,
  difficulty: null,
  bloomLevel: null,
  requiresDiagram: false,
  diagramAsset: null,
  fieldConfidence: {
    question_text: 0.9
  },
  overallConfidence: 0.88,
  validationErrors: [],
  sourceEvidence: {
    page: 1
  },
  approvedQuestionId: null,
  reviewStatus: "EXTRACTED",
  createdAt: new Date("2026-07-03T00:00:00.000Z")
};

const solvedCandidate = {
  questionNumber: "1",
  pageNumber: 1,
  rawOcrText: "1. Define force.",
  cleanedQuestionText: "Define force.",
  questionType: "short_answer",
  marks: 2,
  answerText: "A push or pull acting on an object.",
  solutionText: "Force changes or tends to change the state of motion of an object.",
  answerSourceType: "LLM_GENERATED",
  answerSourceBacked: false,
  requiresDiagram: false,
  fieldConfidence: {
    question_text: 0.92,
    answer_text: 0.9
  },
  overallConfidence: 0.9,
  validationErrors: ["LLM_GENERATED_ANSWER_UNVERIFIED"],
  sourceEvidence: {
    page: 1
  }
};
