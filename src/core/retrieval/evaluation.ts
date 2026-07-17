function atK<T>(values: readonly T[], k: number): readonly T[] {
  if (!Number.isInteger(k) || k < 0) {
    throw new Error("k must be a non-negative integer.");
  }
  return values.slice(0, k);
}

/** Fraction of unique expected identities recovered among the first k results. */
export function recallAtK(expectedCanonicalIds: readonly string[], rankedCanonicalIds: readonly string[], k: number): number {
  const expected = new Set(expectedCanonicalIds);
  if (expected.size === 0) return 1;
  const found = new Set(atK(rankedCanonicalIds, k).filter((id) => expected.has(id)));
  return found.size / expected.size;
}

/** Reciprocal rank of the first expected identity among the first k results. */
export function mrrAtK(expectedCanonicalIds: readonly string[], rankedCanonicalIds: readonly string[], k: number): number {
  const expected = new Set(expectedCanonicalIds);
  const rank = atK(rankedCanonicalIds, k).findIndex((id) => expected.has(id));
  return rank === -1 ? 0 : 1 / (rank + 1);
}

/** A refusal is correct exactly when an unanswerable case has no returned evidence. */
export function refusalAccuracy(answerable: boolean, returnedCanonicalIds: readonly string[]): number {
  return Number(answerable ? returnedCanonicalIds.length > 0 : returnedCanonicalIds.length === 0);
}
