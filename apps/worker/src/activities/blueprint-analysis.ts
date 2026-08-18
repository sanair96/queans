import {
  blueprintLanguageAnalysisSchema,
  blueprintLanguageTagSchema,
  type BlueprintLanguageAnalysis,
  type BlueprintLanguageEvidence,
  type BlueprintPrimaryLanguageSource
} from "@queans/core";
import type { BlueprintLanguageAnalysisResult } from "@queans/providers";

export interface BlueprintOcrTextPage {
  pageNumber: number;
  markdownText: string;
  plainText: string | null;
}

export interface BlueprintPageAnalysis {
  pageNumber: number;
  detectedLanguages: BlueprintLanguageEvidence[];
  structure: {
    headingCandidates: Array<{ text: string; lineNumber: number }>;
    tableLineCount: number;
    listItemCount: number;
    numberedListItemCount: number;
    keyValueLineCount: number;
    numericLineCount: number;
  };
}

export interface BlueprintOcrAnalysis {
  languageAnalysis: BlueprintLanguageAnalysis;
  pages: BlueprintPageAnalysis[];
}

/**
 * Produces advisory evidence only. OCR markdown remains the source of truth;
 * this does not alter headings, tables, wording, or document hierarchy.
 */
export function analyzeBlueprintOcrPages(input: {
  pages: BlueprintOcrTextPage[];
  primaryLanguage: string | null;
  primaryLanguageSource: BlueprintPrimaryLanguageSource;
  providerLanguageAnalysis: BlueprintLanguageAnalysisResult;
}): BlueprintOcrAnalysis {
  if (input.pages.length === 0) {
    throw new Error("Blueprint language and structure analysis requires at least one OCR page.");
  }

  const pages = input.pages
    .slice()
    .sort((left, right) => left.pageNumber - right.pageNumber)
    .map((page) => analyzePage(page, input.providerLanguageAnalysis));
  const detectedLanguages = mergeProviderDetectedLanguages(aggregateLanguages(pages), input.providerLanguageAnalysis);
  const primaryLanguage = selectPrimaryLanguage({
    detectedLanguages,
    primaryLanguage: input.primaryLanguage,
    primaryLanguageSource: input.primaryLanguageSource,
    inferredPrimaryLanguage: input.providerLanguageAnalysis.primaryLanguage,
    documentAnalysis: input.providerLanguageAnalysis.documentAnalysis
  });
  const mixedLanguagePageNumbers = input.providerLanguageAnalysis.mixedLanguagePageNumbers;
  const duplicatePairs = likelyDuplicateLanguagePairs(pages);
  const multilingualRelationship = input.providerLanguageAnalysis.multilingualRelationship;

  return {
    languageAnalysis: blueprintLanguageAnalysisSchema.parse({
      detectedLanguages,
      primaryLanguage,
      mixedLanguagePageNumbers,
      multilingualRelationship,
      metadata: {
        languageProvider: {
          provider: input.providerLanguageAnalysis.provider,
          model: input.providerLanguageAnalysis.model,
          usage: definedValues(input.providerLanguageAnalysis.usage),
          rawResponse: input.providerLanguageAnalysis.rawJson
        },
        likelyDuplicateLanguagePairs: duplicatePairs,
        documentAnalysis: input.providerLanguageAnalysis.documentAnalysis,
        structureAnalysis: pages.map((page) => ({ pageNumber: page.pageNumber, ...page.structure }))
      }
    }),
    pages
  };
}


// Utility function to strip images, links, markdown, formatting characters and normalize whitespaces
export function plainTextFromMarkdown(markdown: string) {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/[`*_>#|]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function analyzePage(page: BlueprintOcrTextPage, providerLanguageAnalysis: BlueprintLanguageAnalysisResult): BlueprintPageAnalysis {
  const lines = page.markdownText.split(/\r?\n/u);
  let tableLineCount = 0;
  let listItemCount = 0;
  let numberedListItemCount = 0;
  let keyValueLineCount = 0;
  let numericLineCount = 0;
  const headingCandidates: Array<{ text: string; lineNumber: number }> = [];

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    if (/^\|.*\|$/u.test(trimmed)) {
      tableLineCount += 1;
    }
    if (/^(?:[-*+]\s+|\d+[.)]\s+)/u.test(trimmed)) {
      listItemCount += 1;
    }
    if (/^\d+[.)]\s+/u.test(trimmed)) {
      numberedListItemCount += 1;
    }
    if (/^[^:]{1,160}:\s+\S/u.test(trimmed)) {
      keyValueLineCount += 1;
    }
    if (/\d/u.test(trimmed)) {
      numericLineCount += 1;
    }

    const heading = headingText(trimmed);
    if (heading && headingCandidates.length < 100) {
      headingCandidates.push({ text: heading, lineNumber: index + 1 });
    }
  });

  return {
    pageNumber: page.pageNumber,
    detectedLanguages: providerLanguagesForPage(providerLanguageAnalysis, page.pageNumber),
    structure: {
      headingCandidates,
      tableLineCount,
      listItemCount,
      numberedListItemCount,
      keyValueLineCount,
      numericLineCount
    }
  };
}

function providerLanguagesForPage(providerLanguageAnalysis: BlueprintLanguageAnalysisResult, pageNumber: number) {
  const providerPage = providerLanguageAnalysis.pageLanguages.find((page) => page.pageNumber === pageNumber);
  if (!providerPage) {
    throw new Error(`Blueprint language analysis is missing language evidence for page ${pageNumber}.`);
  }
  return providerPage.languages.map((language) => ({
    tag: blueprintLanguageTagSchema.parse(language.tag),
    displayName: language.displayName,
    confidence: language.confidence ?? null,
    pageNumbers: [pageNumber]
  }));
}

function headingText(line: string) {
  const markdownHeading = line.match(/^#{1,6}\s+(.+)$/u)?.[1];
  if (markdownHeading) {
    return markdownHeading.slice(0, 1_000);
  }

  const boldHeading = line.match(/^\*\*(.+)\*\*$/u)?.[1];
  if (boldHeading) {
    return boldHeading.slice(0, 1_000);
  }

  if (line.length <= 160 && /^[\p{Lu}\d][\p{Lu}\d\s:().,&/-]+$/u.test(line) && /\p{L}/u.test(line)) {
    return line.slice(0, 1_000);
  }

  return undefined;
}

function aggregateLanguages(pages: BlueprintPageAnalysis[]) {
  const aggregate = new Map<string, { pageNumbers: number[]; confidenceTotal: number; confidenceCount: number }>();
  for (const page of pages) {
    for (const language of page.detectedLanguages) {
      const entry = aggregate.get(language.tag) ?? { pageNumbers: [], confidenceTotal: 0, confidenceCount: 0 };
      entry.pageNumbers.push(page.pageNumber);
      if (language.confidence !== null && language.confidence !== undefined) {
        entry.confidenceTotal += language.confidence;
        entry.confidenceCount += 1;
      }
      aggregate.set(language.tag, entry);
    }
  }

  return [...aggregate.entries()]
    .map(([tag, value]) => ({
      tag,
      confidence: value.confidenceCount > 0 ? roundConfidence(value.confidenceTotal / value.confidenceCount) : null,
      pageNumbers: value.pageNumbers.sort((left, right) => left - right)
    }))
    .sort((left, right) => (right.pageNumbers.length - left.pageNumbers.length) || left.tag.localeCompare(right.tag));
}

function mergeProviderDetectedLanguages(
  detectedLanguages: BlueprintLanguageEvidence[],
  providerLanguageAnalysis: BlueprintLanguageAnalysisResult
) {
  const byTag = new Map(detectedLanguages.map((language) => [language.tag, language]));
  for (const providerLanguage of providerLanguageAnalysis.detectedLanguages) {
    const tag = blueprintLanguageTagSchema.parse(providerLanguage.tag);
    const existing = byTag.get(tag);
    const pageNumbers = [...new Set([...(existing?.pageNumbers ?? []), ...(providerLanguage.pageNumbers ?? [])])].sort(
      (left, right) => left - right
    );
    byTag.set(tag, {
      tag,
      ...(providerLanguage.displayName ? { displayName: providerLanguage.displayName } : {}),
      confidence: providerLanguage.confidence ?? existing?.confidence ?? null,
      ...(pageNumbers.length > 0 ? { pageNumbers } : {})
    });
  }

  return [...byTag.values()].sort(
    (left, right) => (right.pageNumbers?.length ?? 0) - (left.pageNumbers?.length ?? 0) || left.tag.localeCompare(right.tag)
  );
}

function selectPrimaryLanguage(input: {
  detectedLanguages: BlueprintLanguageEvidence[];
  primaryLanguage: string | null;
  primaryLanguageSource: BlueprintPrimaryLanguageSource;
  inferredPrimaryLanguage?: BlueprintLanguageAnalysisResult["primaryLanguage"] | undefined;
  documentAnalysis: BlueprintLanguageAnalysisResult["documentAnalysis"];
}) {
  if (input.primaryLanguage) {
    const tag = blueprintLanguageTagSchema.parse(input.primaryLanguage);
    if (!input.detectedLanguages.some((language) => language.tag === tag)) {
      input.detectedLanguages.push({ tag, confidence: null, pageNumbers: [] });
    }
    return {
      tag,
      source: input.primaryLanguageSource === "UNRESOLVED" ? "UPLOAD_METADATA" : input.primaryLanguageSource,
      confidence: 1,
      requiresConfirmation: false
    } as const;
  }

  const inferredTag = input.inferredPrimaryLanguage?.tag
    ? blueprintLanguageTagSchema.parse(input.inferredPrimaryLanguage.tag)
    : undefined;
  if (inferredTag && !input.detectedLanguages.some((language) => language.tag === inferredTag)) {
    input.detectedLanguages.push({
      tag: inferredTag,
      confidence: input.inferredPrimaryLanguage?.confidence ?? null,
      pageNumbers: []
    });
  }
  const candidate =
    (inferredTag ? input.detectedLanguages.find((language) => language.tag === inferredTag) : undefined) ?? input.detectedLanguages[0];
  if (!candidate) {
    return { tag: null, source: "UNRESOLVED", confidence: null, requiresConfirmation: true } as const;
  }

  const uncertainTag = candidate.tag === "und" || candidate.tag.startsWith("und-");
  const titleOrHeaderAgrees = [input.documentAnalysis.titleLanguageTag, input.documentAnalysis.headerLanguageTag]
    .filter((tag): tag is string => Boolean(tag))
    .some((tag) => sameLanguage(tag, candidate.tag));
  const confidentlyIdentifiedByDocument = input.documentAnalysis.documentType !== "UNKNOWN" && titleOrHeaderAgrees &&
    (input.inferredPrimaryLanguage?.confidence ?? candidate.confidence ?? 0) >= 0.85;
  return {
    tag: candidate.tag,
    source: "INFERRED",
    confidence: input.inferredPrimaryLanguage?.confidence ?? candidate.confidence ?? 0,
    requiresConfirmation: !confidentlyIdentifiedByDocument && (
      uncertainTag ||
      input.detectedLanguages.length > 1 ||
      (input.inferredPrimaryLanguage?.confidence ?? candidate.confidence ?? 0) < 0.85
    )
  } as const;
}

function sameLanguage(left: string, right: string) {
  return left.toLowerCase().split("-")[0] === right.toLowerCase().split("-")[0];
}

function likelyDuplicateLanguagePairs(pages: BlueprintPageAnalysis[]) {
  const pairs: Array<{ pageNumbers: [number, number]; languageTags: [string, string] }> = [];
  for (let index = 0; index < pages.length; index += 1) {
    const left = pages[index];
    const leftLanguage = left?.detectedLanguages[0]?.tag;
    if (!left || !leftLanguage) continue;
    for (const right of pages.slice(index + 1)) {
      const rightLanguage = right.detectedLanguages[0]?.tag;
      if (!rightLanguage || leftLanguage === rightLanguage) continue;
      if (numericStructureSignature(left) === numericStructureSignature(right) && hasNumericStructure(left)) {
        pairs.push({ pageNumbers: [left.pageNumber, right.pageNumber], languageTags: [leftLanguage, rightLanguage] });
      }
    }
  }
  return pairs;
}

function numericStructureSignature(page: BlueprintPageAnalysis) {
  const structure = page.structure;
  return [
    structure.tableLineCount,
    structure.listItemCount,
    structure.numberedListItemCount,
    structure.keyValueLineCount,
    structure.numericLineCount
  ].join(":");
}

function hasNumericStructure(page: BlueprintPageAnalysis) {
  return page.structure.numericLineCount > 0;
}

function roundConfidence(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

function definedValues(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
