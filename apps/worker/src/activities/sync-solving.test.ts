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
  },
  parseMistralChatCandidateBatchBody: vi.fn(),
  parseMistralExtractionContent: vi.fn(),
  parseMistralSolvingContent: vi.fn()
}));

const { solveQuestionsAndPersist } = await import("./llm.activities.js");

describe("solveQuestionsAndPersist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.$transaction.mockImplementation(async (callback: (tx: typeof mocks.tx) => Promise<unknown>) =>
      callback(mocks.tx)
    );
    mocks.prisma.ocrBlock.findMany.mockResolvedValue([]);
    mocks.tx.questionCandidate.findUnique.mockResolvedValue({
      id: "candidate-1",
      approvedQuestionId: null,
      reviewStatus: "EXTRACTED"
    });
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
