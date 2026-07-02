export const duplicateMatchThreshold = 0.74;
export const duplicateConflictThreshold = 0.88;

export interface CandidateDuplicateSource {
  id: string;
  cleanedQuestionText: string;
}

export interface ApprovedQuestionDuplicateSource {
  id: string;
  questionText: string;
}

export interface DuplicateMatchInput {
  candidateId: string;
  questionId: string | null;
  similarity: number;
  conflict: boolean;
  details: {
    matchType: "approved_question" | "same_paper_candidate";
    matchedQuestionText: string;
    matchedCandidateId?: string;
    matchedQuestionId?: string;
  };
}

export function normalizeQuestionText(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function questionTextSimilarity(left: string, right: string) {
  const normalizedLeft = normalizeQuestionText(left);
  const normalizedRight = normalizeQuestionText(right);

  if (!normalizedLeft || !normalizedRight) {
    return 0;
  }

  if (normalizedLeft === normalizedRight) {
    return 1;
  }

  const leftTokens = new Set(normalizedLeft.split(" "));
  const rightTokens = new Set(normalizedRight.split(" "));
  const intersectionSize = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const unionSize = new Set([...leftTokens, ...rightTokens]).size;

  return unionSize > 0 ? roundSimilarity(intersectionSize / unionSize) : 0;
}

export function isDuplicateConflict(similarity: number) {
  return similarity >= duplicateConflictThreshold;
}

export function buildDuplicateMatchInputs(
  candidates: CandidateDuplicateSource[],
  approvedQuestions: ApprovedQuestionDuplicateSource[]
) {
  const matches: DuplicateMatchInput[] = [];

  for (const candidate of candidates) {
    for (const question of approvedQuestions) {
      const similarity = questionTextSimilarity(candidate.cleanedQuestionText, question.questionText);
      if (similarity < duplicateMatchThreshold) {
        continue;
      }

      matches.push({
        candidateId: candidate.id,
        questionId: question.id,
        similarity,
        conflict: isDuplicateConflict(similarity),
        details: {
          matchType: "approved_question",
          matchedQuestionId: question.id,
          matchedQuestionText: question.questionText
        }
      });
    }
  }

  for (let index = 0; index < candidates.length; index += 1) {
    const earlierCandidate = candidates[index];
    if (!earlierCandidate) {
      continue;
    }

    for (let laterIndex = index + 1; laterIndex < candidates.length; laterIndex += 1) {
      const laterCandidate = candidates[laterIndex];
      if (!laterCandidate) {
        continue;
      }

      const similarity = questionTextSimilarity(earlierCandidate.cleanedQuestionText, laterCandidate.cleanedQuestionText);
      if (similarity < duplicateMatchThreshold) {
        continue;
      }

      matches.push({
        candidateId: laterCandidate.id,
        questionId: null,
        similarity,
        conflict: isDuplicateConflict(similarity),
        details: {
          matchType: "same_paper_candidate",
          matchedCandidateId: earlierCandidate.id,
          matchedQuestionText: earlierCandidate.cleanedQuestionText
        }
      });
    }
  }

  return matches;
}

function roundSimilarity(value: number) {
  return Number(value.toFixed(4));
}
