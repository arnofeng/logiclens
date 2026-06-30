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
  protoExtractor,
  goGrpcExtractor,
  javaGrpcExtractor,
  javaDubboExtractor,
  dubboXmlExtractor,
  pythonGrpcExtractor,
  jsGrpcExtractor,
  sharedSymbolExtractor,
  envConfigExtractor,
  pythonExtractor,
  pythonEventExtractor,
  javaEventExtractor,
  goExtractor,
  graphqlSdlExtractor
];
