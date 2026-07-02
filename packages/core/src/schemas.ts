import { z } from "zod";

export const maxUploadByteSize = 50 * 1024 * 1024;
export const supportedUploadMimeTypes = ["application/pdf"] as const;

export const paperContextSchema = z.object({
  title: z.string().trim().min(1).optional(),
  board: z.string().trim().min(1).optional(),
  classLevel: z.string().trim().min(1).optional(),
  subject: z.string().trim().min(1).optional(),
  year: z.number().int().min(1900).max(2200).optional(),
  schoolName: z.string().trim().min(1).optional(),
  examType: z.string().trim().min(1).optional(),
  uploadedBy: z.string().trim().min(1).optional(),
  metadata: z.record(z.unknown()).optional()
});

export const uploadInitSchema = z.object({
  fileName: z.string().min(1),
  mimeType: z.enum(supportedUploadMimeTypes, {
    errorMap: () => ({ message: "Only PDF uploads are supported by the current OCR pipeline." })
  }),
  byteSize: z
    .number()
    .int()
    .positive()
    .max(maxUploadByteSize, "Uploads must be 50 MB or smaller for OCR processing."),
  checksumSha256: z.string().min(32).optional()
});

export const uploadCompleteSchema = z.object({
  etag: z.string().optional(),
  byteSize: z.number().int().positive().optional(),
  paperContext: paperContextSchema.optional()
});

const reviewDecisionSchema = z.enum([
  "APPROVE",
  "EDIT_AND_APPROVE",
  "REJECT",
  "MARK_DUPLICATE",
  "NEEDS_MORE_INFO",
  "MARK_UNPROCESSABLE"
]);

const reviewedQuestionTypeSchema = z.enum(
  ["MCQ", "SHORT_ANSWER", "LONG_ANSWER", "NUMERICAL", "TRUE_FALSE", "FILL_IN_THE_BLANK", "MATCHING", "DIAGRAM"],
  {
    errorMap: () => ({ message: "Question type is required for edit approval." })
  }
);

const reviewedMcqOptionsSchema = z
  .array(z.string().trim().min(1, "MCQ options cannot be blank."))
  .min(2, "MCQ options require at least two choices.");

const editAndApprovePayloadSchema = z
  .object({
    candidate: z.object({
      cleanedQuestionText: z.string().trim().min(1, "Question text is required for edit approval."),
      questionType: reviewedQuestionTypeSchema,
      options: reviewedMcqOptionsSchema.nullable().optional(),
      diagramAsset: z.unknown().optional(),
      answerText: z.string().trim().min(1, "Answer text is required for edit approval."),
      solutionText: z.string().optional(),
      marks: z
        .number({
          required_error: "Marks are required for edit approval.",
          invalid_type_error: "Marks are required for edit approval."
        })
        .nonnegative("Marks must be a non-negative number."),
      difficulty: z.string().optional()
    })
  })
  .superRefine((value, context) => {
    if (value.candidate.questionType === "MCQ" && value.candidate.options == null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["candidate", "options"],
        message: "MCQ options are required for edit approval."
      });
    }
  });

export const reviewPatchSchema = z
  .object({
    decision: reviewDecisionSchema,
    reviewedBy: z.string().min(1).optional(),
    reviewNotes: z.string().optional(),
    reviewPayload: z.unknown().optional(),
    corrections: z
      .array(
        z.object({
          fieldName: z.string().min(1),
          oldValue: z.unknown().optional(),
          newValue: z.unknown().optional(),
          correctionType: z.enum([
            "OCR_ERROR",
            "WRONG_TOPIC",
            "WRONG_ANSWER",
            "WRONG_MARKS",
            "BAD_SOLUTION",
            "BAD_SEGMENTATION",
            "DUPLICATE",
            "FORMATTING_ISSUE"
          ])
        })
      )
      .optional()
  })
  .superRefine((value, context) => {
    if (value.decision !== "EDIT_AND_APPROVE") {
      return;
    }

    const parsed = editAndApprovePayloadSchema.safeParse(value.reviewPayload);
    if (parsed.success) {
      return;
    }

    for (const issue of parsed.error.issues) {
      context.addIssue({
        ...issue,
        path: ["reviewPayload", ...issue.path]
      });
    }
  });

export type UploadInitInput = z.infer<typeof uploadInitSchema>;
export type UploadCompleteInput = z.infer<typeof uploadCompleteSchema>;
export type PaperContextInput = z.infer<typeof paperContextSchema>;
export type ReviewPatchInput = z.infer<typeof reviewPatchSchema>;
