import type { ContractExtractor } from "../../plugins/types.js";
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
import { goExtractor } from "./goExtractor.js";

export const builtinContractExtractors: ContractExtractor[] = [
  packageJsonExtractor,
  importPackageExtractor,
  javaPackageExtractor,
  springMvcExtractor,
  jsHttpClientExtractor,
  sdkGeneratedClientExtractor,
  eventExtractor,
  sharedSymbolExtractor,
  envConfigExtractor,
  pythonExtractor,
  goExtractor
];
