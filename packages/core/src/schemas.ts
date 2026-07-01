import { z } from "zod";

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
  mimeType: z.string().min(1),
  byteSize: z.number().int().positive(),
  checksumSha256: z.string().min(32).optional()
});

export const uploadCompleteSchema = z.object({
  etag: z.string().optional(),
  byteSize: z.number().int().positive().optional(),
  paperContext: paperContextSchema.optional()
});

export const reviewPatchSchema = z.object({
  decision: z.enum([
    "APPROVE",
    "EDIT_AND_APPROVE",
    "REJECT",
    "SPLIT",
    "MERGE",
    "MARK_DUPLICATE",
    "NEEDS_MORE_INFO",
    "MARK_UNPROCESSABLE"
  ]),
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
});

export type UploadInitInput = z.infer<typeof uploadInitSchema>;
export type UploadCompleteInput = z.infer<typeof uploadCompleteSchema>;
export type PaperContextInput = z.infer<typeof paperContextSchema>;
export type ReviewPatchInput = z.infer<typeof reviewPatchSchema>;
