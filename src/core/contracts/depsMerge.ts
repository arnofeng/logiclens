import type { RepoDependencyEdge } from "../parsing/types.js";

// ---------------------------------------------------------------------------
// Phase 4.2: Merge semantic-materialized deps with legacy deps
// ---------------------------------------------------------------------------

/**
 * Structural key for a dependency edge — identifies the same logical
 * dependency regardless of which evidence produced it.
 */
export function structuralKey(e: RepoDependencyEdge): string {
  return `${e.fromRepoId}:${e.toRepoId}:${e.dependencyType}:${e.sourceContractId}:${e.targetContractId}`;
}

/**
 * Merges semantic-materialized deps with legacy deps.
 *
 * Semantic deps take **structural precedence**: if a semantic dep already
 * covers a `(fromRepo, toRepo, dependencyType, sourceContract, targetContract)`
 * signature, ALL legacy deps with that same structural signature are dropped.
 * Legacy deps fill any gaps not covered by semantic deps.
 *
 * Within each source (semantic or legacy), exact duplicates by evidence-level
 * key (`structuralKey + evidenceId`) are collapsed (first-wins).
 *
 * When a semantic and a legacy edge describe the same structural relationship,
 * the semantic edge's `evidenceId`, `raw`, and `confidence` are retained;
 * the legacy evidence is intentionally discarded as superseded.
 */
export function mergeAndDedupeDeps(
  semanticDeps: RepoDependencyEdge[],
  legacyDeps: RepoDependencyEdge[]
): RepoDependencyEdge[] {
  const seenEvidence = new Set<string>();
  const covered = new Set<string>();
  const result: RepoDependencyEdge[] = [];

  // Semantic deps first — they define the structural coverage.
  for (const dep of semanticDeps) {
    const ek = `${structuralKey(dep)}:${dep.evidenceId}`;
    if (seenEvidence.has(ek)) continue;
    seenEvidence.add(ek);
    covered.add(structuralKey(dep));
    result.push(dep);
  }

  // Legacy deps fill gaps — skip if same structural signature already covered
  // by a semantic dep, and also deduplicate by evidence key within legacy.
  for (const dep of legacyDeps) {
    if (covered.has(structuralKey(dep))) continue;
    const ek = `${structuralKey(dep)}:${dep.evidenceId}`;
    if (seenEvidence.has(ek)) continue;
    seenEvidence.add(ek);
    result.push(dep);
  }

  return result;
}
