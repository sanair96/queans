export interface CandidatePageSpan {
  pageNumber: number | null;
  sourcePageStart: number | null;
  sourcePageEnd: number | null;
}

export interface PageConfidence {
  pageNumber: number;
  averageConfidence: number | null;
  minimumConfidence: number | null;
}

export function candidateOcrConfidence(candidate: CandidatePageSpan, pages: PageConfidence[]) {
  const startPage = candidate.sourcePageStart ?? candidate.pageNumber;
  if (startPage === null) {
    return {};
  }

  const endPage = Math.max(startPage, candidate.sourcePageEnd ?? startPage);
  const selectedPages = pages.filter((page) => page.pageNumber >= startPage && page.pageNumber <= endPage);
  const averageValues = selectedPages
    .map((page) => page.averageConfidence)
    .filter((confidence): confidence is number => confidence !== null);
  const minimumValues = selectedPages
    .map((page) => page.minimumConfidence)
    .filter((confidence): confidence is number => confidence !== null);

  const result: { averageConfidence?: number; minimumConfidence?: number } = {};
  if (averageValues.length > 0) {
    result.averageConfidence = averageValues.reduce((total, confidence) => total + confidence, 0) / averageValues.length;
  }
  if (minimumValues.length > 0) {
    result.minimumConfidence = Math.min(...minimumValues);
  }
  return result;
}
