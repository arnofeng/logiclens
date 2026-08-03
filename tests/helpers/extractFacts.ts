import type { ContractExtractor, ExtractContext } from "../../src/core/registries/types.js";
import type { ExtractedFacts } from "../../src/core/contracts/extraction/contracts.js";
import { ExtractionBuilder } from "../../src/core/contracts/extraction/extractionBuilder.js";

export async function extractFacts(extractor: ContractExtractor, context: ExtractContext): Promise<ExtractedFacts> {
  const collector = new ExtractionBuilder();
  await extractor.extract(context, collector);
  return collector.build();
}
