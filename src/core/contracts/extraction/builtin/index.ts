import type { ContractExtractor } from "../../../registries/types.js";
import { envConfigExtractor } from "./envConfigExtractor.js";
import { eventExtractor } from "./eventExtractor.js";
import { importPackageExtractor } from "./importPackageExtractor.js";
import { javaPackageExtractor } from "./javaPackageExtractor.js";
import { jsHttpClientExtractor } from "./jsHttpClientExtractor.js";
import { packageJsonExtractor } from "./packageJsonExtractor.js";
import { sdkGeneratedClientExtractor } from "./sdkGeneratedClientExtractor.js";
import { sharedSymbolExtractor } from "./sharedSymbolExtractor.js";
import { springMvcExtractor } from "./springMvcExtractor.js";
import { pythonExtractor } from "./pythonExtractor.js";
import { pythonEventExtractor } from "./pythonEventExtractor.js";
import { javaEventExtractor } from "./javaEventExtractor.js";
import { goExtractor } from "./goExtractor.js";
import { tsSchemaExtractor } from "./tsSchemaExtractor.js";
import { javaSchemaExtractor } from "./javaSchemaExtractor.js";
import { pythonSchemaExtractor } from "./pythonSchemaExtractor.js";
import { goSchemaExtractor } from "./goSchemaExtractor.js";

/** Each extractor already self-wraps via compatExtractor at its export site. */
export const builtinContractExtractors: ContractExtractor[] = [
  packageJsonExtractor,
  importPackageExtractor,
  javaPackageExtractor,
  springMvcExtractor,
  jsHttpClientExtractor,
  sdkGeneratedClientExtractor,
  eventExtractor,
  tsSchemaExtractor,
  javaSchemaExtractor,
  pythonSchemaExtractor,
  goSchemaExtractor,
  sharedSymbolExtractor,
  envConfigExtractor,
  pythonExtractor,
  pythonEventExtractor,
  javaEventExtractor,
  goExtractor
];
