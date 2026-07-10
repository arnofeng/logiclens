import type { ParsedGraphFile } from "../parsing/types.js";
import { registerBuiltinParsers, registerCommonParsers } from "../parsing/parserRegistry.js";
import { parserRegistry } from "../registries/registry.js";
import {
  registerCommonContractExtractors,
  registerJavaDubboXmlContractExtractors,
  registerJavaSourceContractExtractors,
  unregisterJavaContractExtractors
} from "../contracts/extraction/builtin/index.js";
import {
  registerCommonFrameworkDetectors,
  registerJavaDubboXmlFrameworkDetectors,
  registerJavaFrameworkDetectors,
  unregisterJavaFrameworkDetectors
} from "../frameworks/detect.js";
import type { LanguageDetection } from "./detection.js";

export function resetJavaBuiltinCapabilities(): void {
  parserRegistry.unregisterLanguage("java");
  unregisterJavaContractExtractors();
  unregisterJavaFrameworkDetectors();
}

export function registerCommonBuiltins(): void {
  registerCommonParsers();
  registerCommonContractExtractors();
  registerCommonFrameworkDetectors();
}

export async function registerBuiltinParsersForActiveLanguages(
  activeLanguages: ReadonlySet<string>,
  javaSignals: LanguageDetection
): Promise<void> {
  const parserLanguages = new Set(activeLanguages);
  if (!javaSignals.hasSourceFiles) parserLanguages.delete("java");
  await registerBuiltinParsers(parserLanguages);
}

export function registerJavaBuiltinsForSignals(javaSignals: LanguageDetection): void {
  if (javaSignals.hasSourceFiles) {
    registerJavaSourceContractExtractors();
    registerJavaFrameworkDetectors();
  } else if (javaSignals.hasBuildMarkers) {
    registerJavaFrameworkDetectors();
  }

  if (javaSignals.hasDubboXml) {
    registerJavaDubboXmlContractExtractors();
    registerJavaDubboXmlFrameworkDetectors();
  }
}

export function registerBuiltinsForParsedFiles(parsedFiles: readonly ParsedGraphFile[]): void {
  registerCommonBuiltins();
  if (parsedFiles.some((file) => file.language === "java")) {
    registerJavaSourceContractExtractors();
    registerJavaFrameworkDetectors();
  }
  if (parsedFiles.some(hasDubboXmlSource)) {
    registerJavaDubboXmlContractExtractors();
    registerJavaDubboXmlFrameworkDetectors();
  }
}

function hasDubboXmlSource(file: ParsedGraphFile): boolean {
  return file.language === "xml" &&
    "source" in file &&
    typeof file.source === "string" &&
    (/<dubbo:(?:service|reference)\b/i.test(file.source) || /xmlns:dubbo\s*=\s*["'][^"']*dubbo[^"']*["']/i.test(file.source));
}
