export function normalizeTaxonomyName(value: string | undefined) {
  const normalized = value?.trim().replace(/\s+/g, " ");
  return normalized && normalized.length > 0 ? normalized : undefined;
}
