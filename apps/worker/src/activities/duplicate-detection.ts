export const duplicateMatchThreshold = 0.74;
export const duplicateConflictThreshold = 0.88;

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

function roundSimilarity(value: number) {
  return Number(value.toFixed(4));
}
