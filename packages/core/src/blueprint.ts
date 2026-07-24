import { z } from "zod";

/**
 * The editable representation of a blueprint. It intentionally has no
 * required object shape: a document defines its own rules and hierarchy.
 */
export type BlueprintRulesJsonValue =
  | null
  | boolean
  | number
  | string
  | BlueprintRulesJsonValue[]
  | { [key: string]: BlueprintRulesJsonValue };

export const blueprintRulesJsonLimits = {
  maxSerializedBytes: 20 * 1024 * 1024, //20 MB max payload size
  maxDepth: 64, // max depth of rules JSON to prevent stack overflow 
  maxStringLength: 500_000, //max length of any string
  maxCollectionEntries: 50_000 // max entries in any collection
} as const;


//Blueprint JSON limits interface
export interface BlueprintRulesJsonLimits {
  maxSerializedBytes: number;
  maxDepth: number;
  maxStringLength: number;
  maxCollectionEntries: number;
}

//Custom error class when Blueprint JSON validation fails
export class BlueprintRulesJsonValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlueprintRulesJsonValidationError";
  }
}

/**
 * Validates a JSON value without imposing a blueprint-specific structure.
 * It is deliberately stricter than JSON.stringify so unsupported JavaScript
 * values cannot be silently coerced or dropped before persistence.
 */
export function assertBlueprintRulesJson(
  value: unknown,
  limits: BlueprintRulesJsonLimits = blueprintRulesJsonLimits
): asserts value is BlueprintRulesJsonValue {
  assertValidLimits(limits);
  assertJsonValue(value, limits, 0, new Set<object>());

  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new BlueprintRulesJsonValidationError("Blueprint rules must be a JSON value.");
  }

  if (new TextEncoder().encode(serialized).byteLength > limits.maxSerializedBytes) {
    throw new BlueprintRulesJsonValidationError(
      `Blueprint rules exceed the ${limits.maxSerializedBytes}-byte payload limit.`
    );
  }
}

export function parseBlueprintRulesJson(
  value: unknown,
  limits: BlueprintRulesJsonLimits = blueprintRulesJsonLimits
): BlueprintRulesJsonValue {
  assertBlueprintRulesJson(value, limits);
  return value;
}

export const blueprintRulesJsonSchema = z.unknown().superRefine((value, context) => {
  try {
    assertBlueprintRulesJson(value);
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : "Blueprint rules must be valid JSON."
    });
  }
});

const boundedConfidenceSchema = z.number().finite().min(0).max(1);

export const blueprintLanguageTagSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine(isValidLanguageTag, "Language tags must be valid BCP 47 tags.")
  .transform(canonicalLanguageTag);

export const blueprintLanguageEvidenceSchema = z.object({
  tag: blueprintLanguageTagSchema,
  displayName: z.string().trim().min(1).max(256).optional(),
  confidence: boundedConfidenceSchema.nullable().optional(),
  pageNumbers: z.array(z.number().int().positive()).max(50_000).optional()
});

export const blueprintPrimaryLanguageSources = [
  "UPLOAD_METADATA",
  "INFERRED",
  "USER_CONFIRMED",
  "UNRESOLVED"
] as const;

export const blueprintPrimaryLanguageSelectionSchema = z
  .object({
    tag: blueprintLanguageTagSchema.nullable(),
    source: z.enum(blueprintPrimaryLanguageSources),
    confidence: boundedConfidenceSchema.nullable(),
    requiresConfirmation: z.boolean()
  })
  .superRefine((value, context) => {
    if (value.tag === null && value.source !== "UNRESOLVED") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source"],
        message: "An unresolved primary language must use the UNRESOLVED source."
      });
    }

    if (value.tag === null && !value.requiresConfirmation) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requiresConfirmation"],
        message: "An unresolved primary language requires confirmation."
      });
    }
  });

export const blueprintMultilingualRelationships = [
  "MONOLINGUAL",
  "DUPLICATE_TRANSLATIONS",
  "DISTINCT_REQUIREMENTS",
  "MIXED_OR_UNCERTAIN"
] as const;

export const blueprintLanguageAnalysisSchema = z
  .object({
    detectedLanguages: z.array(blueprintLanguageEvidenceSchema).min(1).max(512),
    primaryLanguage: blueprintPrimaryLanguageSelectionSchema,
    mixedLanguagePageNumbers: z.array(z.number().int().positive()).max(50_000).default([]),
    multilingualRelationship: z.enum(blueprintMultilingualRelationships),
    metadata: blueprintRulesJsonSchema.optional()
  })
  .superRefine((value, context) => {
    const seen = new Set<string>();
    for (const [index, language] of value.detectedLanguages.entries()) {
      if (seen.has(language.tag)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["detectedLanguages", index, "tag"],
          message: "Detected language tags must be unique."
        });
      }
      seen.add(language.tag);
    }

    if (value.primaryLanguage.tag && !seen.has(value.primaryLanguage.tag)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["primaryLanguage", "tag"],
        message: "The primary language must be one of the detected languages."
      });
    }
  });

export const blueprintSourceReferenceSchema = z
  .object({
    pageNumber: z.number().int().positive(),
    languageTag: blueprintLanguageTagSchema.optional(),
    snippet: z.string().max(500_000).optional(),
    startOffset: z.number().int().nonnegative().optional(),
    endOffset: z.number().int().nonnegative().optional(),
    confidence: boundedConfidenceSchema.nullable().optional()
  })
  .superRefine((value, context) => {
    const hasStartOffset = value.startOffset !== undefined;
    const hasEndOffset = value.endOffset !== undefined;
    if (hasStartOffset !== hasEndOffset) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Source references must provide both character offsets or neither."
      });
      return;
    }

    if (value.startOffset !== undefined && value.endOffset !== undefined && value.endOffset < value.startOffset) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endOffset"],
        message: "Source reference endOffset must not precede startOffset."
      });
    }
  });

export const blueprintExtractionEnvelopeSchema = z.object({
  rules: blueprintRulesJsonSchema,
  languageAnalysis: blueprintLanguageAnalysisSchema,
  confidence: boundedConfidenceSchema.nullable(),
  sourceReferences: z.array(blueprintSourceReferenceSchema).max(50_000),
  warnings: z.array(z.string().max(10_000)).max(10_000).default([]),
  providerMetadata: blueprintRulesJsonSchema.optional()
});

export const blueprintDocumentStatuses = [
  "UPLOADED",
  "QUEUED",
  "PROCESSING",
  "READY_FOR_APPROVAL",
  "NEEDS_REVIEW",
  "APPROVED",
  "FAILED"
] as const;

export const defaultBlueprintBoard = "General";

export const blueprintDocumentMetadataSchema = z.object({
  title: z.string().trim().min(1).max(1_024).nullable(),
  originalFilename: z.string().min(1).max(1_024),
  documentType: z.string().trim().min(1).max(256).nullable(),
  board: z.string().trim().min(1).max(512).default(defaultBlueprintBoard),
  subject: z.string().trim().min(1).max(512).nullable(),
  academicLevel: z.string().trim().min(1).max(512).nullable(),
  uploadObjectId: z.string().uuid(),
  pageCount: z.number().int().nonnegative().nullable(),
  status: z.enum(blueprintDocumentStatuses),
  languageAnalysis: blueprintLanguageAnalysisSchema.nullable(),
  confidenceSummary: blueprintRulesJsonSchema.nullable(),
  extractionMetadata: blueprintRulesJsonSchema.nullable(),
  extractionError: z.string().max(10_000).nullable(),
  reviewVersion: z.number().int().nonnegative(),
  approvedAt: z.date().nullable(),
  approvedBy: z.string().trim().min(1).max(512).nullable()
});

export type BlueprintLanguageTag = z.output<typeof blueprintLanguageTagSchema>;
export type BlueprintLanguageEvidence = z.output<typeof blueprintLanguageEvidenceSchema>;
export type BlueprintPrimaryLanguageSelection = z.output<typeof blueprintPrimaryLanguageSelectionSchema>;
export type BlueprintLanguageAnalysis = z.output<typeof blueprintLanguageAnalysisSchema>;
export type BlueprintSourceReference = z.output<typeof blueprintSourceReferenceSchema>;
export type BlueprintExtractionEnvelope = z.output<typeof blueprintExtractionEnvelopeSchema>;
export type BlueprintDocumentMetadata = z.output<typeof blueprintDocumentMetadataSchema>;
export type BlueprintDocumentStatus = (typeof blueprintDocumentStatuses)[number];
export type BlueprintPrimaryLanguageSource = (typeof blueprintPrimaryLanguageSources)[number];

function assertJsonValue(value: unknown, limits: BlueprintRulesJsonLimits, depth: number, ancestors: Set<object>): void {
  if (depth > limits.maxDepth) {
    throw new BlueprintRulesJsonValidationError(`Blueprint rules exceed the maximum depth of ${limits.maxDepth}.`);
  }

  if (value === null || typeof value === "boolean") {
    return;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new BlueprintRulesJsonValidationError("Blueprint rules cannot contain non-finite numbers.");
    }
    return;
  }

  if (typeof value === "string") {
    assertStringLength(value, limits, "string");
    return;
  }

  if (typeof value !== "object") {
    throw new BlueprintRulesJsonValidationError("Blueprint rules can contain only JSON values.");
  }

  if (ancestors.has(value)) {
    throw new BlueprintRulesJsonValidationError("Blueprint rules cannot contain circular structures.");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      assertJsonArray(value, limits, depth, ancestors);
    } else {
      assertJsonObject(value, limits, depth, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function assertJsonArray(value: unknown[], limits: BlueprintRulesJsonLimits, depth: number, ancestors: Set<object>) {
  if (value.length > limits.maxCollectionEntries) {
    throw new BlueprintRulesJsonValidationError(
      `Blueprint rule arrays cannot exceed ${limits.maxCollectionEntries} entries.`
    );
  }

  for (const key of Object.getOwnPropertyNames(value)) {
    if (key === "length" || isArrayIndex(key, value.length)) {
      continue;
    }
    throw new BlueprintRulesJsonValidationError("Blueprint rule arrays cannot contain non-index properties.");
  }

  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new BlueprintRulesJsonValidationError("Blueprint rules cannot contain symbol keys.");
  }

  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new BlueprintRulesJsonValidationError("Blueprint rule arrays cannot contain empty slots.");
    }
    assertJsonValue(value[index], limits, depth + 1, ancestors);
  }
}

function assertJsonObject(value: object, limits: BlueprintRulesJsonLimits, depth: number, ancestors: Set<object>) {
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new BlueprintRulesJsonValidationError("Blueprint rule objects must be plain JSON objects.");
  }

  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new BlueprintRulesJsonValidationError("Blueprint rules cannot contain symbol keys.");
  }

  const keys = Object.getOwnPropertyNames(value);
  if (keys.length > limits.maxCollectionEntries) {
    throw new BlueprintRulesJsonValidationError(
      `Blueprint rule objects cannot exceed ${limits.maxCollectionEntries} properties.`
    );
  }

  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new BlueprintRulesJsonValidationError("Blueprint rule objects must contain enumerable data properties only.");
    }
    assertStringLength(key, limits, "object key");
    assertJsonValue(descriptor.value, limits, depth + 1, ancestors);
  }
}



//validates string length of blueprint rules json
function assertStringLength(value: string, limits: BlueprintRulesJsonLimits, label: string) {
  if (value.length > limits.maxStringLength) {
    throw new BlueprintRulesJsonValidationError(
      `Blueprint rule ${label}s cannot exceed ${limits.maxStringLength} characters.`
    );
  }
}

//validates limits of blueprint rules json
function assertValidLimits(limits: BlueprintRulesJsonLimits) {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`Blueprint JSON limit ${name} must be a positive integer.`);
    }
  }
}

function isArrayIndex(key: string, length: number) {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < length && String(index) === key;
}

function isValidLanguageTag(value: string) {
  try {
    Intl.getCanonicalLocales(value);
    return true;
  } catch {
    return false;
  }
}

function canonicalLanguageTag(value: string) {
  return Intl.getCanonicalLocales(value)[0] ?? value;
}
