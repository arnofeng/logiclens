import {
  canonicalDubboContractKey,
  canonicalGraphqlContractKey,
  canonicalGrpcContractKey,
  canonicalHttpContractKey
} from "./apiPath.js";
import { canonicalEventContractKey } from "./event.js";

/** Contract kinds recognized as the leading token of a semantic target. */
const SEMANTIC_KINDS = new Set([
  "http", "api", "event", "schema", "dto", "grpc", "dubbo", "graphql", "package", "config"
]);

const HTTP_VERBS = new Set([
  "GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"
]);

/**
 * Normalizes a free-form contract target into the `kind:key` form understood by
 * ContractSpec lookup. Accepted examples:
 *   - "http POST /orders"
 *   - "POST /orders"
 *   - "event OrderCreated"
 *   - "schema CreateOrderRequest"
 *   - "grpc OrderService/CreateOrder"
 *   - "dubbo com.acme.OrderService#createOrder"
 *   - "graphql Query.user"
 */
export function normalizeSemanticTarget(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;

  // Split leading kind token. Support both "kind key..." and "kind:key...".
  let kind: string | undefined;
  let rest = trimmed;

  const colonIdx = trimmed.indexOf(":");
  const firstSpace = trimmed.search(/\s/);
  const colonKindCandidate = colonIdx > 0 ? trimmed.slice(0, colonIdx).toLowerCase() : "";
  const spaceKindCandidate = firstSpace > 0 ? trimmed.slice(0, firstSpace).toLowerCase() : "";

  if (colonIdx > 0 && SEMANTIC_KINDS.has(colonKindCandidate) && (colonIdx < firstSpace || firstSpace === -1)) {
    kind = colonKindCandidate;
    rest = trimmed.slice(colonIdx + 1).trim();
  } else if (firstSpace > 0 && SEMANTIC_KINDS.has(spaceKindCandidate)) {
    kind = spaceKindCandidate;
    rest = trimmed.slice(firstSpace + 1).trim();
  } else {
    // No explicit kind. Infer http if it looks like "VERB /path".
    const tokens = trimmed.split(/\s+/);
    if (tokens.length >= 2 && HTTP_VERBS.has(tokens[0]!.toUpperCase())) {
      kind = "http";
    }
  }

  if (kind === "http" || kind === "api") {
    const { method, path } = splitMethodPath(rest);
    const key = canonicalHttpContractKey({ method, path });
    return `http:${key}`;
  }
  if (kind === "event") {
    return `event:${canonicalEventContractKey(rest)}`;
  }
  if (kind === "dto" || kind === "schema") {
    return `schema:${rest}`; // schema names match case-sensitively by name
  }
  if (kind === "grpc") {
    return `grpc:${canonicalGrpcContractKey(rest)}`;
  }
  if (kind === "dubbo") {
    const { interfaceName, method } = splitDubboTarget(rest);
    return `dubbo:${canonicalDubboContractKey(interfaceName, method)}`;
  }
  if (kind === "graphql") {
    const { operationType, field } = splitGraphqlTarget(rest);
    return `graphql:${canonicalGraphqlContractKey(operationType, field)}`;
  }
  if (kind === "package" || kind === "config") {
    return `${kind}:${rest}`;
  }

  // Fall back: pass through unchanged (ContractSpec lookup handles bare schema
  // names and any kind:key forms that are not natural semantic targets).
  return trimmed;
}

/** Splits "POST /orders" or "POST:/orders" into method + path. */
function splitMethodPath(rest: string): { method?: string; path: string } {
  const sep = rest.search(/[\s:]/);
  if (sep > 0) {
    const head = rest.slice(0, sep);
    if (HTTP_VERBS.has(head.toUpperCase())) {
      return { method: head.toUpperCase(), path: rest.slice(sep + 1).trim() };
    }
  }
  return { path: rest };
}

/** Splits "com.acme.OrderService#createOrder" into interface + method. */
function splitDubboTarget(rest: string): { interfaceName: string; method?: string } {
  const hashIdx = rest.indexOf("#");
  if (hashIdx === -1) return { interfaceName: rest.trim() };
  return {
    interfaceName: rest.slice(0, hashIdx).trim(),
    method: rest.slice(hashIdx + 1).trim() || undefined
  };
}

/** Splits "Query.user" / "Mutation.createOrder" into root type + field. */
function splitGraphqlTarget(rest: string): { operationType: string; field: string } {
  const dotIdx = rest.indexOf(".");
  if (dotIdx === -1) return { operationType: "query", field: rest.trim() };
  return {
    operationType: rest.slice(0, dotIdx).trim(),
    field: rest.slice(dotIdx + 1).trim()
  };
}
