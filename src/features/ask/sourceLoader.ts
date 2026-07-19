import {
  parseRenderRef,
  RenderRefError,
  type ParsedRenderRef,
} from "../../core/retrieval/renderRef.js";
import {
  WorkspaceLexicalStoreError,
  type WorkspaceLexicalStore,
} from "../../core/retrieval/provider.js";
import type { LexicalDocument } from "../../core/retrieval/types.js";
import { stableCandidateKey, type CandidateProvenance } from "./candidates.js";
import type { FusedRetrievalCandidate } from "./fusion.js";

export type SourceLoadRejectionReason =
  | "unlocatable"
  | "malformed_render_ref"
  | "cross_workspace"
  | "missing_document"
  | "inactive_document"
  | "document_identity_mismatch"
  | "unsafe_path"
  | "provider_unavailable"
  | "provider_failed";

export type SourceLoadRejection = Readonly<{
  candidateKey: string;
  documentId?: string;
  reason: SourceLoadRejectionReason;
}>;

export type LoadedEvidence = Readonly<{
  candidate: FusedRetrievalCandidate;
  provenance: CandidateProvenance;
  document: LexicalDocument;
  parsedRenderRef: ParsedRenderRef;
}>;

export type SourceLoadStatus =
  | "completed"
  | "skipped"
  | "unavailable"
  | "failed";

export type SourceLoadResult = Readonly<{
  evidence: readonly LoadedEvidence[];
  rejections: readonly SourceLoadRejection[];
  status: SourceLoadStatus;
  queryCount: number;
  reason?: "no_loadable_documents" | "provider_unavailable" | "provider_failed";
}>;

type Loadable = Readonly<{
  candidate: FusedRetrievalCandidate;
  provenance: CandidateProvenance;
  parsed: ParsedRenderRef;
}>;

function reject(
  candidate: FusedRetrievalCandidate,
  reason: SourceLoadRejectionReason,
  documentId?: string,
): SourceLoadRejection {
  return Object.freeze({
    candidateKey: stableCandidateKey(candidate),
    ...(documentId ? { documentId } : {}),
    reason,
  });
}

function parseLoadable(
  candidate: FusedRetrievalCandidate,
  provenance: CandidateProvenance,
  workspaceId: string,
): { value?: Loadable; rejection?: SourceLoadRejection } {
  if (!provenance.documentId || !provenance.renderRef)
    return {
      rejection: reject(candidate, "unlocatable", provenance.documentId),
    };
  try {
    const parsed = parseRenderRef(provenance.renderRef, workspaceId);
    if (!parsed.path)
      return {
        rejection: reject(candidate, "unlocatable", provenance.documentId),
      };
    if (
      parsed.repoId !== candidate.repoId ||
      parsed.canonicalId !== candidate.canonicalId ||
      parsed.kind !== candidate.kind
    ) {
      return {
        rejection: reject(
          candidate,
          "document_identity_mismatch",
          provenance.documentId,
        ),
      };
    }
    return { value: { candidate, provenance, parsed } };
  } catch (error) {
    if (error instanceof RenderRefError) {
      return {
        rejection: reject(
          candidate,
          error.code === "workspace_mismatch"
            ? "cross_workspace"
            : error.code === "field_invalid"
              ? "unsafe_path"
              : "malformed_render_ref",
          provenance.documentId,
        ),
      };
    }
    throw error;
  }
}

function validateDocument(
  loadable: Loadable,
  document: LexicalDocument,
  workspaceId: string,
): ParsedRenderRef | SourceLoadRejection {
  const id = loadable.provenance.documentId!;
  if (document.workspaceId !== workspaceId)
    return reject(loadable.candidate, "cross_workspace", id);
  if (
    document.id !== id ||
    document.repoId !== loadable.candidate.repoId ||
    document.canonicalId !== loadable.candidate.canonicalId ||
    document.kind !== loadable.candidate.kind
  ) {
    return reject(loadable.candidate, "document_identity_mismatch", id);
  }
  if (!document.active)
    return reject(loadable.candidate, "inactive_document", id);
  try {
    const parsed = parseRenderRef(document.renderRef, workspaceId);
    if (
      !parsed.path ||
      parsed.path !== document.path ||
      parsed.repoId !== document.repoId ||
      parsed.canonicalId !== document.canonicalId ||
      parsed.kind !== document.kind ||
      parsed.fileId !== loadable.parsed.fileId ||
      parsed.path !== loadable.parsed.path ||
      (loadable.parsed.startLine !== undefined && parsed.startLine !== loadable.parsed.startLine) ||
      (loadable.parsed.endLine !== undefined && parsed.endLine !== loadable.parsed.endLine)
    ) {
      return reject(
        loadable.candidate,
        parsed.path ? "document_identity_mismatch" : "unlocatable",
        id,
      );
    }
    return parsed;
  } catch (error) {
    if (error instanceof RenderRefError) {
      return reject(
        loadable.candidate,
        error.code === "workspace_mismatch"
          ? "cross_workspace"
          : error.code === "field_invalid"
            ? "unsafe_path"
            : "malformed_render_ref",
        id,
      );
    }
    throw error;
  }
}

export async function loadSelectedEvidence(
  input: Readonly<{
    workspaceId: string;
    selectedCandidates: readonly FusedRetrievalCandidate[];
    store?: WorkspaceLexicalStore;
    storeUnavailable?: boolean;
  }>,
): Promise<SourceLoadResult> {
  const rejections: SourceLoadRejection[] = [];
  const loadables: Loadable[] = [];
  const seen = new Set<string>();
  for (const candidate of input.selectedCandidates) {
    let candidateHadLoadable = false;
    let candidateHadReference = false;
    for (const provenance of candidate.provenance) {
      if (!provenance.documentId || !provenance.renderRef) continue;
      candidateHadReference = true;
      const parsed = parseLoadable(candidate, provenance, input.workspaceId);
      if (parsed.rejection) rejections.push(parsed.rejection);
      if (!parsed.value || seen.has(parsed.value.provenance.documentId!))
        continue;
      candidateHadLoadable = true;
      seen.add(parsed.value.provenance.documentId!);
      loadables.push(parsed.value);
    }
    if (!candidateHadLoadable && !candidateHadReference)
      rejections.push(reject(candidate, "unlocatable"));
  }
  if (loadables.length === 0) {
    return Object.freeze({
      evidence: Object.freeze([]),
      rejections: Object.freeze(rejections),
      status: "skipped",
      queryCount: 0,
      reason: "no_loadable_documents",
    });
  }
  if (!input.store || input.storeUnavailable) {
    rejections.push(
      ...loadables.map(({ candidate, provenance }) =>
        reject(candidate, "provider_unavailable", provenance.documentId),
      ),
    );
    return Object.freeze({
      evidence: Object.freeze([]),
      rejections: Object.freeze(rejections),
      status: "unavailable",
      queryCount: 0,
      reason: "provider_unavailable",
    });
  }

  let documents: readonly LexicalDocument[];
  try {
    documents = await input.store.loadDocuments({
      workspaceId: input.workspaceId,
      documentIds: loadables.map(({ provenance }) => provenance.documentId!),
    });
  } catch (error) {
    if (!(error instanceof WorkspaceLexicalStoreError)) throw error;
    rejections.push(
      ...loadables.map(({ candidate, provenance }) =>
        reject(candidate, "provider_failed", provenance.documentId),
      ),
    );
    return Object.freeze({
      evidence: Object.freeze([]),
      rejections: Object.freeze(rejections),
      status: "failed",
      queryCount: 1,
      reason: "provider_failed",
    });
  }

  const byId = new Map(documents.map((document) => [document.id, document]));
  const evidence: LoadedEvidence[] = [];
  for (const loadable of loadables) {
    const id = loadable.provenance.documentId!;
    const document = byId.get(id);
    if (!document) {
      rejections.push(reject(loadable.candidate, "missing_document", id));
      continue;
    }
    const validated = validateDocument(loadable, document, input.workspaceId);
    if ("reason" in validated) rejections.push(validated);
    else
      evidence.push(
        Object.freeze({
          candidate: loadable.candidate,
          provenance: loadable.provenance,
          document: Object.freeze({ ...document }),
          parsedRenderRef: Object.freeze(validated),
        }),
      );
  }
  return Object.freeze({
    evidence: Object.freeze(evidence),
    rejections: Object.freeze(rejections),
    status: "completed",
    queryCount: 1,
  });
}
