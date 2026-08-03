import type { ContractExtractor } from "../../../registries/types.js";

/** Contextual typing helper; it does not adapt or wrap the extractor at runtime. */
export function defineBuiltinExtractor(extractor: ContractExtractor): ContractExtractor {
  return extractor;
}
