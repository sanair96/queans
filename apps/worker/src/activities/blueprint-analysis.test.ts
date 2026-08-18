import { describe, expect, it } from "vitest";

import type { BlueprintLanguageAnalysisResult } from "@queans/providers";

import { analyzeBlueprintOcrPages, plainTextFromMarkdown } from "./blueprint-analysis.js";

function languageAnalysisForPages(input: {
  pageLanguages: Array<{ pageNumber: number; tag: string }>;
  primaryLanguage: string | null;
  multilingualRelationship: BlueprintLanguageAnalysisResult["multilingualRelationship"];
}): BlueprintLanguageAnalysisResult {
  return {
    provider: "mistral",
    model: "test-model",
    detectedLanguages: input.pageLanguages.map((page) => ({ tag: page.tag, confidence: 0.99, pageNumbers: [page.pageNumber] })),
    primaryLanguage: { tag: input.primaryLanguage, confidence: input.primaryLanguage ? 0.95 : null },
    mixedLanguagePageNumbers: [],
    multilingualRelationship: input.multilingualRelationship,
    pageLanguages: input.pageLanguages.map((page) => ({
      pageNumber: page.pageNumber,
      languages: [{ tag: page.tag, confidence: 0.99 }]
    })),
    documentAnalysis: {
      documentType: "MARKING_SCHEME",
      isMarkingScheme: true,
      confidence: 0.99,
      titleLanguageTag: input.primaryLanguage,
      headerLanguageTag: input.primaryLanguage,
      evidencePageNumbers: [input.pageLanguages[0]?.pageNumber ?? 1],
      evaluatorInstructionPageNumbers: [],
      markingSchemePageNumbers: input.pageLanguages.map((page) => page.pageNumber),
      paperCode: null
    },
    rawJson: {},
    usage: {}
  };
}

describe("Blueprint OCR language and structure analysis", () => {
  it("preserves page-level language evidence while using upload metadata as the primary-language choice", () => {
    const result = analyzeBlueprintOcrPages({
      pages: [
        {
          pageNumber: 1,
          markdownText: "# Question Paper\nSection A\nTotal Marks: 80",
          plainText: null
        },
        {
          pageNumber: 2,
          markdownText: "# प्रश्न पत्र\nखंड अ\nकुल अंक: 80",
          plainText: null
        }
      ],
      primaryLanguage: "hi",
      primaryLanguageSource: "UPLOAD_METADATA",
      providerLanguageAnalysis: languageAnalysisForPages({
        pageLanguages: [
          { pageNumber: 1, tag: "en" },
          { pageNumber: 2, tag: "hi" }
        ],
        primaryLanguage: "hi",
        multilingualRelationship: "DUPLICATE_TRANSLATIONS"
      })
    });

    expect(result.languageAnalysis.detectedLanguages.map((language) => language.tag)).toEqual(
      expect.arrayContaining(["en", "hi"])
    );
    expect(result.languageAnalysis.primaryLanguage).toEqual({
      tag: "hi",
      source: "UPLOAD_METADATA",
      confidence: 1,
      requiresConfirmation: false
    });
    expect(result.pages[0]?.detectedLanguages[0]?.pageNumbers).toEqual([1]);
    expect(result.pages[1]?.detectedLanguages[0]?.pageNumbers).toEqual([2]);
  });

  it("identifies likely repeated bilingual layouts without changing their OCR text", () => {
    const result = analyzeBlueprintOcrPages({
      pages: [
        {
          pageNumber: 1,
          markdownText: "# Section A\n1. Answer all questions.\n10 × 1 = 10",
          plainText: null
        },
        {
          pageNumber: 2,
          markdownText: "# खंड अ\n1. सभी प्रश्नों के उत्तर दीजिए।\n10 × 1 = 10",
          plainText: null
        }
      ],
      primaryLanguage: null,
      primaryLanguageSource: "UNRESOLVED",
      providerLanguageAnalysis: languageAnalysisForPages({
        pageLanguages: [
          { pageNumber: 1, tag: "en" },
          { pageNumber: 2, tag: "hi" }
        ],
        primaryLanguage: "en",
        multilingualRelationship: "DUPLICATE_TRANSLATIONS"
      })
    });

    expect(result.languageAnalysis.multilingualRelationship).toBe("DUPLICATE_TRANSLATIONS");
    expect(result.languageAnalysis.mixedLanguagePageNumbers).toEqual([]);
    expect(result.languageAnalysis.primaryLanguage.requiresConfirmation).toBe(false);
  });

  it("records headings, tables, lists, and key-value relationships as advisory structure evidence", () => {
    const result = analyzeBlueprintOcrPages({
      pages: [
        {
          pageNumber: 4,
          markdownText: [
            "# Assessment Pattern",
            "Duration: 3 hours",
            "| Unit | Marks |",
            "| --- | ---: |",
            "| Algebra | 20 |",
            "- Answer every question",
            "1. Draw diagrams where necessary"
          ].join("\n"),
          plainText: null
        }
      ],
      primaryLanguage: null,
      primaryLanguageSource: "UNRESOLVED",
      providerLanguageAnalysis: languageAnalysisForPages({
        pageLanguages: [{ pageNumber: 4, tag: "chr" }],
        primaryLanguage: "chr",
        multilingualRelationship: "MONOLINGUAL"
      })
    });

    expect(result.pages[0]?.structure).toMatchObject({
      headingCandidates: [{ text: "Assessment Pattern", lineNumber: 1 }],
      tableLineCount: 3,
      listItemCount: 2,
      numberedListItemCount: 1,
      keyValueLineCount: 2,
      numericLineCount: 3
    });
    expect(result.languageAnalysis.primaryLanguage.tag).toBe("chr");
  });

  it("creates readable plain text from OCR markdown without mutating the stored markdown", () => {
    expect(plainTextFromMarkdown("# **Section A**\n[Read this](https://example.test)")).toBe("Section A Read this");
  });
});
