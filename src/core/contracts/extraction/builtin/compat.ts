// ---------------------------------------------------------------------------
// Backward-compat wrapper for extractors.  Old tests call extract(context)
// without a FactCollector.  This wrapper detects the 1-arg form, creates a
// builder internally, and returns ExtractedFacts so existing tests keep working.
// ---------------------------------------------------------------------------

import type { ContractExtractor, ExtractContext, PostExtractContext } from "../../../plugins/types.js";
import type { FactCollector } from "../factCollector.js";
import type { ExtractedFacts } from "../contracts.js";
import { ExtractionBuilder } from "../extractionBuilder.js";

/**
 * Wraps a new-style extractor so it also accepts the legacy 1-argument
 * calling convention (used by tests).  When called without a collector,
 * creates a builder internally and returns the frozen facts.
 */
export function compatExtractor(
  ext: ContractExtractor
): ContractExtractor & { extract(context: ExtractContext): Promise<ExtractedFacts> } {
  const origExtract = ext.extract.bind(ext);
  const origPostExtract = ext.postExtract?.bind(ext);

  return {
    ...ext,
    extract(context: ExtractContext, collector?: FactCollector): any {
      if (collector) return origExtract(context, collector);
      const builder = new ExtractionBuilder();
      return Promise.resolve(origExtract(context, builder)).then(() => builder.build());
    },
    postExtract: origPostExtract
      ? (context: PostExtractContext, collector?: FactCollector): any => {
          if (collector) return origPostExtract(context, collector);
          const builder = new ExtractionBuilder();
          return Promise.resolve(origPostExtract(context, builder)).then(() => builder.build());
        }
      : undefined,
  } as any;
}
