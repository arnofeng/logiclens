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
import { protoExtractor } from "./protoExtractor.js";
import { goGrpcExtractor } from "./goGrpcExtractor.js";
import { javaGrpcExtractor } from "./javaGrpcExtractor.js";
import { javaDubboExtractor } from "./javaDubboExtractor.js";
import { dubboXmlExtractor } from "./dubboXmlExtractor.js";
import { pythonGrpcExtractor } from "./pythonGrpcExtractor.js";
import { jsGrpcExtractor } from "./jsGrpcExtractor.js";
import { graphqlSdlExtractor } from "./graphqlSdlExtractor.js";
import { graphqlClientExtractor } from "./graphqlClientExtractor.js";
import { contractExtractorRegistry } from "../../../registries/registry.js";

/** Each extractor already self-wraps via compatExtractor at its export site. */
export const commonBuiltinContractExtractors: ContractExtractor[] = [
  packageJsonExtractor,
  importPackageExtractor,
  jsHttpClientExtractor,
  sdkGeneratedClientExtractor,
  eventExtractor,
  tsSchemaExtractor,
  pythonSchemaExtractor,
  goSchemaExtractor,
  protoExtractor,
  goGrpcExtractor,
  pythonGrpcExtractor,
  jsGrpcExtractor,
  sharedSymbolExtractor,
  envConfigExtractor,
  pythonExtractor,
  pythonEventExtractor,
  goExtractor,
  graphqlSdlExtractor,
  graphqlClientExtractor
];

export const javaSourceContractExtractors: ContractExtractor[] = [
  javaPackageExtractor,
  springMvcExtractor,
  javaSchemaExtractor,
  javaGrpcExtractor,
  javaDubboExtractor,
  javaEventExtractor
];

export const javaDubboXmlContractExtractors: ContractExtractor[] = [
  dubboXmlExtractor
];

export const builtinContractExtractors: ContractExtractor[] = [
  ...commonBuiltinContractExtractors,
  ...javaSourceContractExtractors,
  ...javaDubboXmlContractExtractors
];

function registerExtractorGroup(extractors: readonly ContractExtractor[]): void {
  for (const extractor of extractors) {
    if (!contractExtractorRegistry.resolve(extractor.name)) {
      contractExtractorRegistry.register(extractor);
    }
  }
}

function unregisterExtractorGroup(extractors: readonly ContractExtractor[]): void {
  for (const extractor of extractors) {
    if (contractExtractorRegistry.resolve(extractor.name) === extractor) {
      contractExtractorRegistry.unregister(extractor.name);
    }
  }
}

export function registerCommonContractExtractors(): void {
  registerExtractorGroup(commonBuiltinContractExtractors);
}

export function registerJavaSourceContractExtractors(): void {
  registerExtractorGroup(javaSourceContractExtractors);
}

export function registerJavaDubboXmlContractExtractors(): void {
  registerExtractorGroup(javaDubboXmlContractExtractors);
}

export function unregisterJavaContractExtractors(): void {
  unregisterExtractorGroup(javaSourceContractExtractors);
  unregisterExtractorGroup(javaDubboXmlContractExtractors);
}

export function registeredContractExtractors(): ContractExtractor[] {
  return contractExtractorRegistry.extractors();
}
