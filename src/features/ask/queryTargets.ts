import type { QuerySpan } from "./queryLexer.js";
import { DEFAULT_QUERY_PLANNING_CONTEXT, type QueryPlanningContext } from "./planningContext.js";

export type ContractTargetKind = "api" | "event" | "schema" | "dto" | "enum";

export type ContractTarget = {
  kind: ContractTargetKind;
  value: string;
  method?: string;
};

export type ClassifiedTarget =
  | { type: "identifier"; value: string; span: QuerySpan }
  | { type: "path"; value: string; span: QuerySpan }
  | ({ type: "contract"; span: QuerySpan } & ContractTarget)
  | { type: "ignored"; reason: "url" | "version" | "context" | "ambiguous"; span: QuerySpan };

const HTTP_METHOD = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i;
const CONTRACT_CONTEXT = /^(?:event|schema|dto|enum|事件|架构|模式|枚举|数据传输对象)$/i;
const FILE_LEADING_CONTEXT = /^(?:open|check|read|inspect|(?:然后)?(?:打开|查看|读取|检查))$/i;
const FILE_LABEL_CONTEXT = /^(?:file|path|directory|folder|文件|路径|目录|文件夹)$/i;
const FILE_CONTEXT = /^(?:file|path|directory|folder|open|check|read|inspect|文件|路径|目录|文件夹|(?:然后)?(?:打开|查看|读取|检查))$/i;
const API_LEADING_CONTEXT = /^(?:calls?|serves?|consumes?|request|response|http|query|(?:这个|分析|查看|解释)?(?:接口|端点|路由)|(?:然后)?(?:谁)?调用|(?:然后)?(?:查询|请求|消费|提供))$/i;
const API_LABEL_CONTEXT = /^(?:api|endpoint|route|(?:这个|分析|查看|解释)?(?:接口|端点|路由))$/i;
const API_CONTEXT = /^(?:api|calls?|serves?|consumes?|endpoint|route|request|response|http|query|(?:这个|分析|查看|解释)?(?:接口|端点|路由)|(?:然后)?(?:谁)?调用|(?:然后)?(?:查询|请求|消费|提供))$/i;
const CODE_CONTEXT = /^(?:class|function|method|symbol|interface|type|类|函数|方法|符号|接口|类型)$/i;
const URL_CONTEXT = /^(?:visit|url|website|site|访问|网址|网站)$/i;
const CONNECTOR = /^(?:and|or|then|but|以及|并且|然后|但|而且)$/i;
const VERSION = /^v?\d+(?:\.\d+){2,}(?:[-+][\w.-]+)?$/i;

function canonicalPunctuation(value: string): string {
  return value.replace(/：/gu, ":");
}

function normalizedWord(span: QuerySpan): string {
  return canonicalPunctuation(span.value.normalize("NFC")).toLowerCase();
}

function hasClauseBoundary(spans: readonly QuerySpan[], first: number, second: number): boolean {
  if (spans[first]?.clause !== spans[second]?.clause) return true;
  const start = Math.min(first, second) + 1;
  const end = Math.max(first, second);
  return spans.slice(start, end).some((span) => CONNECTOR.test(normalizedWord(span)));
}

function hasKnownFileExtension(value: string, context: QueryPlanningContext): boolean {
  const clean = value.split(/[?#]/, 1)[0]?.replace(/[\\/]+$/, "") ?? "";
  const lower = clean.toLowerCase();
  return context.fileExtensions.some((extension) => lower.endsWith(extension));
}

function isGenericFileName(value: string): boolean {
  return /(?:^|[\\/])[^\\/]+\.[\p{L}\p{N}]{1,16}$/u.test(value);
}

function isStrongFileShape(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\/]+[\\/]/.test(value) || /^(?:\.\.?[\\/]|~[\\/])/.test(value);
}

function isRelativePathShape(value: string): boolean {
  return !value.startsWith("/") && /[\\/]/.test(value);
}

function isStrongCodeShape(value: string): boolean {
  if (/^[A-Z][a-z\d]+(?:[A-Z][A-Za-z\d]*)+$/.test(value)) return true;
  if (/^[a-z][A-Za-z\d]*[A-Z][A-Za-z\d]*$/.test(value)) return true;
  if (/^[A-Za-z][A-Za-z\d]*_[A-Za-z\d_]+$/.test(value)) return true;
  if (/^[A-Z][A-Z\d_]+$/.test(value)) return true;
  const segments = value.split(".");
  return segments.length > 1 && segments.every((segment) => /^[A-Za-z_$][\w$]*$/.test(segment)) &&
    segments.some((segment) => /^[A-Z]/.test(segment) || /[A-Z_]/.test(segment.slice(1)));
}

function isSimplePascalCase(value: string): boolean {
  return /^[A-Z][a-z\d]*$/.test(value);
}

function isStructuredContractValue(value: string): boolean {
  return /^(?:[\p{L}\p{N}]+[._-])+[\p{L}\p{N}]+$/u.test(value);
}

function explicitContract(value: string): ContractTarget | undefined {
  const canonical = canonicalPunctuation(value);
  const api = canonical.match(/^api:(?:(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS):)?(\/[^\s]+)$/i);
  if (api) return { kind: "api", value: api[2]!, ...(api[1] ? { method: api[1].toUpperCase() } : {}) };
  const methodApi = canonical.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS):(\/[^\s]+)$/i);
  if (methodApi) return { kind: "api", value: methodApi[2]!, method: methodApi[1]!.toUpperCase() };
  const named = canonical.match(/^(event|schema|dto|enum):(.+)$/i);
  if (named?.[2]) return { kind: named[1]!.toLowerCase() as ContractTargetKind, value: named[2] };
  return undefined;
}

type EvidenceTargetClass = "any" | "path";

function isPotentialTargetSpan(span: QuerySpan, targetClass: EvidenceTargetClass, context: QueryPlanningContext): boolean {
  const value = span.value;
  if (explicitContract(value)) return true;
  if (value.startsWith("/") || isStrongFileShape(value) || isRelativePathShape(value)) return true;
  if (hasKnownFileExtension(value, context) || isGenericFileName(value)) return true;
  if (targetClass === "path") return false;
  if (span.quoted) return true;
  return isStrongCodeShape(value) || isSimplePascalCase(value) || isStructuredContractValue(value);
}

type EvidenceDirection = "before" | "after" | "either";
type EvidenceTieDirection = "preceding" | "following";

function evidenceBindsTarget(
  spans: readonly QuerySpan[],
  targetIndex: number,
  evidenceIndex: number,
  direction: EvidenceDirection,
  maxDistance: number,
  targetClass: EvidenceTargetClass,
  tieDirection: EvidenceTieDirection,
  context: QueryPlanningContext
): boolean {
  if (direction === "before" && evidenceIndex >= targetIndex) return false;
  if (direction === "after" && evidenceIndex <= targetIndex) return false;
  const distance = Math.abs(evidenceIndex - targetIndex);
  if (distance > maxDistance || hasClauseBoundary(spans, evidenceIndex, targetIndex)) return false;
  const candidates = spans
    .map((span, index) => ({ span, index, distance: Math.abs(index - evidenceIndex) }))
    .filter(({ span, index, distance: candidateDistance }) =>
      index !== evidenceIndex && candidateDistance <= maxDistance && isPotentialTargetSpan(span, targetClass, context) &&
      !hasClauseBoundary(spans, evidenceIndex, index) &&
      (direction !== "before" || index > evidenceIndex) &&
      (direction !== "after" || index < evidenceIndex)
    )
    .sort((left, right) =>
      left.distance - right.distance ||
      (tieDirection === "following" ? right.index - left.index : left.index - right.index)
    );
  return candidates[0]?.index === targetIndex;
}

function boundEvidenceDistance(
  spans: readonly QuerySpan[],
  targetIndex: number,
  pattern: RegExp,
  direction: EvidenceDirection = "either",
  maxDistance = 4,
  targetClass: EvidenceTargetClass = "any",
  tieDirection: EvidenceTieDirection = "preceding",
  context: QueryPlanningContext = DEFAULT_QUERY_PLANNING_CONTEXT
): number | undefined {
  let bestDistance: number | undefined;
  for (let evidenceIndex = 0; evidenceIndex < spans.length; evidenceIndex += 1) {
    if (!pattern.test(normalizedWord(spans[evidenceIndex]!))) continue;
    const distance = Math.abs(evidenceIndex - targetIndex);
    if (!evidenceBindsTarget(spans, targetIndex, evidenceIndex, direction, maxDistance, targetClass, tieDirection, context)) continue;
    if (bestDistance === undefined || distance < bestDistance) bestDistance = distance;
  }
  return bestDistance;
}

function minimumDistance(...distances: Array<number | undefined>): number | undefined {
  const present = distances.filter((distance): distance is number => distance !== undefined);
  return present.length > 0 ? Math.min(...present) : undefined;
}

function isStructuralUrl(value: string, spans: readonly QuerySpan[], index: number, context: QueryPlanningContext): boolean {
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) return true;
  if (/^localhost(?::\d+)?(?:\/|$)/i.test(value)) return true;
  if (/^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:\/|$)/.test(value)) return true;
  if (/^\[[0-9a-f:]+\](?::\d+)?(?:\/|$)/i.test(value) || /^[0-9a-f]*:[0-9a-f:]+(?:\/|$)/i.test(value)) return true;
  if (/^(?:[\p{L}\p{N}-]+\.)+[\p{L}\p{N}-]+(?::\d+)?\/(?:[^\s]*)$/u.test(value)) return true;
  return /^(?:[\p{L}\p{N}-]+\.)+[\p{L}\p{N}-]+$/u.test(value) && boundEvidenceDistance(spans, index, URL_CONTEXT, "before", 2, "path", "preceding", context) !== undefined;
}

function implicitContractFromSuffix(value: string): ContractTarget | undefined {
  if (/Schema$/.test(value) && isStrongCodeShape(value)) return { kind: "schema", value };
  if (/(?:DTO|Dto)$/.test(value) && isStrongCodeShape(value)) return { kind: "dto", value };
  return undefined;
}

function contractContextKind(spans: readonly QuerySpan[], index: number, context: QueryPlanningContext): ContractTargetKind | undefined {
  const contextIndex = spans
    .map((span, candidateIndex) => ({ span, candidateIndex, distance: Math.abs(candidateIndex - index) }))
    .filter(({ span, candidateIndex, distance }) =>
      CONTRACT_CONTEXT.test(normalizedWord(span)) && distance <= 3 &&
      !hasClauseBoundary(spans, candidateIndex, index) &&
      evidenceBindsTarget(spans, index, candidateIndex, "either", 3, "any", "preceding", context)
    )
    .sort((left, right) => left.distance - right.distance || left.candidateIndex - right.candidateIndex)[0]?.candidateIndex;
  if (contextIndex === undefined) return undefined;
  const word = normalizedWord(spans[contextIndex]!);
  if (word === "事件") return "event";
  if (word === "架构" || word === "模式") return "schema";
  if (word === "枚举") return "enum";
  if (word === "数据传输对象") return "dto";
  return word as ContractTargetKind;
}

function classifySpan(spans: readonly QuerySpan[], index: number, context: QueryPlanningContext): ClassifiedTarget {
  const span = spans[index]!;
  const value = span.value.normalize("NFC");
  const explicit = explicitContract(value);
  if (explicit) return { type: "contract", span, ...explicit };

  if (isStructuralUrl(value, spans, index, context)) return { type: "ignored", reason: "url", span };
  if (VERSION.test(value)) return { type: "ignored", reason: "version", span };

  const methodIndex = spans
    .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
    .filter(({ candidate, candidateIndex }) => HTTP_METHOD.test(normalizedWord(candidate)) && candidateIndex < index)
    .filter(({ candidateIndex }) => evidenceBindsTarget(spans, index, candidateIndex, "before", 4, "path", "following", context))
    .sort((left, right) => right.candidateIndex - left.candidateIndex)[0]?.candidateIndex;
  const method = methodIndex === undefined ? undefined : normalizedWord(spans[methodIndex]!).toUpperCase();
  const fileDistance = minimumDistance(
    boundEvidenceDistance(spans, index, FILE_LEADING_CONTEXT, "before", 4, "path", "preceding", context),
    boundEvidenceDistance(spans, index, FILE_LABEL_CONTEXT, "before", 4, "path", "preceding", context),
    boundEvidenceDistance(spans, index, FILE_LABEL_CONTEXT, "after", 4, "path", "preceding", context)
  );
  const apiDistance = minimumDistance(
    boundEvidenceDistance(spans, index, API_LEADING_CONTEXT, "before", 4, "path", "preceding", context),
    boundEvidenceDistance(spans, index, API_LABEL_CONTEXT, "either", 4, "path", "following", context)
  );
  const fileEvidence = fileDistance !== undefined && (apiDistance === undefined || fileDistance < apiDistance);
  const apiEvidence = apiDistance !== undefined && (fileDistance === undefined || apiDistance <= fileDistance);
  const slashLike = value.startsWith("/");

  if (hasKnownFileExtension(value, context) || isStrongFileShape(value) || (fileEvidence && (isGenericFileName(value) || isRelativePathShape(value)))) {
    return { type: "path", value, span };
  }
  if (slashLike) {
    if (method) return { type: "contract", kind: "api", value, method, span };
    if (apiEvidence) return { type: "contract", kind: "api", value, span };
    if (fileEvidence) return { type: "path", value, span };
    if (spans.length === 1) return { type: "contract", kind: "api", value, span };
    return { type: "ignored", reason: "ambiguous", span };
  }

  const contextualKind = contractContextKind(spans, index, context);
  if (contextualKind && (span.quoted || isStrongCodeShape(value) || isSimplePascalCase(value) || isStructuredContractValue(value))) {
    return { type: "contract", kind: contextualKind, value, span };
  }
  const suffixedContract = implicitContractFromSuffix(value);
  if (suffixedContract) return { type: "contract", span, ...suffixedContract };

  if (CONTRACT_CONTEXT.test(normalizedWord(span)) || HTTP_METHOD.test(normalizedWord(span)) || FILE_CONTEXT.test(normalizedWord(span)) || API_CONTEXT.test(normalizedWord(span)) || CODE_CONTEXT.test(normalizedWord(span)) || URL_CONTEXT.test(normalizedWord(span)) || CONNECTOR.test(normalizedWord(span))) {
    return { type: "ignored", reason: "context", span };
  }

  const codeEvidence = boundEvidenceDistance(spans, index, CODE_CONTEXT, "either", 4, "any", "preceding", context) !== undefined;
  if (isStrongCodeShape(value) || (isSimplePascalCase(value) && codeEvidence) || (span.quoted && codeEvidence)) {
    return { type: "identifier", value, span };
  }
  return { type: "ignored", reason: "ambiguous", span };
}

export function classifyQueryTargets(
  spans: readonly QuerySpan[],
  context: QueryPlanningContext = DEFAULT_QUERY_PLANNING_CONTEXT
): ClassifiedTarget[] {
  return spans.map((_, index) => classifySpan(spans, index, context));
}
