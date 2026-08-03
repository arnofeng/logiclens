import { describe, it } from "vitest";
import { runSchemaAdapterContract, SCHEMA_ADAPTER_LANGUAGES } from "./helpers/schemaAdapterContract.js";

describe("schema adapter deterministic contract", () => {
  it.each(SCHEMA_ADAPTER_LANGUAGES)("%s satisfies the shared identity, resolution, truncation, and provenance protocol", (languageId) => {
    runSchemaAdapterContract(languageId);
  });
});
