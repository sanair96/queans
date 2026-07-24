import { describe, expect, it } from "vitest";

import {
  assertBlueprintRulesJson,
  blueprintDocumentMetadataSchema,
  blueprintExtractionEnvelopeSchema,
  blueprintLanguageAnalysisSchema,
  blueprintRulesJsonSchema,
  parseBlueprintRulesJson
} from "./blueprint.js";

describe("blueprint rules JSON", () => {
  it("accepts an arbitrary native JSON structure and every JSON primitive", () => {
    const rules = {
      examPattern: { duration: "3 hours", maximumMarks: 80 },
      instructions: ["Answer all questions", true, null, 1.5],
      custom_board_label: { "": "empty JSON keys are preserved" }
    };

    expect(parseBlueprintRulesJson(rules)).toEqual(rules);
    for (const value of [null, true, false, 0, "Hindi", [], {}]) {
      expect(blueprintRulesJsonSchema.safeParse(value).success).toBe(true);
    }
  });

  it("preserves unfamiliar board terminology without imposing fields", () => {
    const rules = {
      "अंक-वितरण": [{ इकाई: "बीजगणित", भारांक: "40%" }],
      "internal-choice-policy": "विद्यालय-विशिष्ट"
    };

    expect(parseBlueprintRulesJson(rules)).toEqual(rules);
  });

  it("rejects values that JSON would silently coerce or drop", () => {
    for (const value of [undefined, Number.NaN, Infinity, BigInt(1), new Date(), () => "rule"]) {
      expect(() => assertBlueprintRulesJson(value)).toThrow();
    }
  });

  it("rejects circular structures and sparse arrays", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const sparse = new Array(1);

    expect(() => assertBlueprintRulesJson(circular)).toThrow("circular");
    expect(() => assertBlueprintRulesJson(sparse)).toThrow("empty slots");
  });

  it("enforces configurable JSON limits", () => {
    expect(() => assertBlueprintRulesJson({ deep: { value: true } }, { maxSerializedBytes: 1_000, maxDepth: 1, maxStringLength: 10, maxCollectionEntries: 10 })).toThrow(
      "maximum depth"
    );
    expect(() => assertBlueprintRulesJson("long", { maxSerializedBytes: 1_000, maxDepth: 2, maxStringLength: 3, maxCollectionEntries: 10 })).toThrow(
      "cannot exceed 3 characters"
    );
    expect(() => assertBlueprintRulesJson([1, 2], { maxSerializedBytes: 1_000, maxDepth: 2, maxStringLength: 10, maxCollectionEntries: 1 })).toThrow(
      "cannot exceed 1 entries"
    );
    expect(() => assertBlueprintRulesJson("payload", { maxSerializedBytes: 2, maxDepth: 2, maxStringLength: 10, maxCollectionEntries: 10 })).toThrow(
      "payload limit"
    );
  });
});

describe("blueprint language policy", () => {
  const detectedLanguages = [
    { tag: "en-in", displayName: "English", confidence: 0.96, pageNumbers: [1, 2] },
    { tag: "hi", displayName: "Hindi", confidence: 0.94, pageNumbers: [1, 2] }
  ];

  it("canonicalizes BCP 47 language tags and records repeated bilingual content", () => {
    const analysis = blueprintLanguageAnalysisSchema.parse({
      detectedLanguages,
      primaryLanguage: { tag: "en-IN", source: "INFERRED", confidence: 0.8, requiresConfirmation: true },
      mixedLanguagePageNumbers: [1, 2],
      multilingualRelationship: "DUPLICATE_TRANSLATIONS"
    });

    expect(analysis.detectedLanguages[0]?.tag).toBe("en-IN");
    expect(analysis.multilingualRelationship).toBe("DUPLICATE_TRANSLATIONS");
  });

  it("keeps unresolved primary-language selections reviewable", () => {
    expect(
      blueprintLanguageAnalysisSchema.parse({
        detectedLanguages: [{ tag: "hi", pageNumbers: [1] }],
        primaryLanguage: { tag: null, source: "UNRESOLVED", confidence: null, requiresConfirmation: true },
        multilingualRelationship: "MIXED_OR_UNCERTAIN"
      }).primaryLanguage.tag
    ).toBeNull();
  });

  it("rejects duplicate detected languages and invalid language tags", () => {
    expect(() =>
      blueprintLanguageAnalysisSchema.parse({
        detectedLanguages: [{ tag: "en" }, { tag: "en" }],
        primaryLanguage: { tag: "en", source: "USER_CONFIRMED", confidence: 1, requiresConfirmation: false },
        multilingualRelationship: "DUPLICATE_TRANSLATIONS"
      })
    ).toThrow("must be unique");
    expect(() =>
      blueprintLanguageAnalysisSchema.parse({
        detectedLanguages: [{ tag: "not a language" }],
        primaryLanguage: { tag: null, source: "UNRESOLVED", confidence: null, requiresConfirmation: true },
        multilingualRelationship: "MONOLINGUAL"
      })
    ).toThrow("BCP 47");
  });
});

describe("blueprint metadata and source references", () => {
  it("defaults a missing board to General without adding it to rules", () => {
    const metadata = blueprintDocumentMetadataSchema.parse({
      title: "Class X Mathematics",
      originalFilename: "blueprint.pdf",
      documentType: "Blueprint",
      subject: "Mathematics",
      academicLevel: "Class X",
      uploadObjectId: "b6f00b2e-f1f3-4122-bbb2-005aed3bf44c",
      pageCount: null,
      status: "QUEUED",
      languageAnalysis: null,
      confidenceSummary: null,
      extractionMetadata: null,
      extractionError: null,
      reviewVersion: 0,
      approvedAt: null,
      approvedBy: null
    });

    expect(metadata.board).toBe("General");
    expect(metadata).not.toHaveProperty("rules");
  });

  it("validates page-level source references while allowing provider-neutral metadata", () => {
    expect(
      blueprintExtractionEnvelopeSchema.parse({
        rules: { section: "प्रश्न" },
        languageAnalysis: {
          detectedLanguages: [{ tag: "hi", pageNumbers: [3] }],
          primaryLanguage: { tag: "hi", source: "USER_CONFIRMED", confidence: 1, requiresConfirmation: false },
          multilingualRelationship: "MONOLINGUAL"
        },
        confidence: 0.9,
        sourceReferences: [
          { pageNumber: 3, languageTag: "hi", snippet: "प्रश्न", startOffset: 20, endOffset: 26, confidence: 0.9 }
        ],
        providerMetadata: { provider: "test" }
      }).sourceReferences
    ).toHaveLength(1);

    expect(() =>
      blueprintExtractionEnvelopeSchema.parse({
        rules: {},
        languageAnalysis: {
          detectedLanguages: [{ tag: "en" }],
          primaryLanguage: { tag: "en", source: "USER_CONFIRMED", confidence: 1, requiresConfirmation: false },
          multilingualRelationship: "MONOLINGUAL"
        },
        confidence: null,
        sourceReferences: [{ pageNumber: 1, startOffset: 4 }]
      })
    ).toThrow("both character offsets");
  });
});
