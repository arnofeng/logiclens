// ---------------------------------------------------------------------------
// Phase 5: Event Impact Rules
//
// Determines impact severity for event consumers/producers when a topic
// is renamed, removed, or has its payload schema changed.
// ---------------------------------------------------------------------------

import type { ContractSpecNode, SemanticRelationKind } from "../../../parsers/types.js";
import { deserializeSpec, type EventSpec } from "../../spec.js";
import type { ChangeIntent, ImpactItem } from "../types.js";

/**
 * Assesses the impact of a contract change on an event consumer or producer.
 */
export function assessEventChange(
  change: ChangeIntent,
  dependentSpec: ContractSpecNode,
  relationKind: SemanticRelationKind,
  reason: string,
  confidence: number
): ImpactItem[] {
  const eventSpec = deserializeSpec(dependentSpec.specJson) as EventSpec;
  if (eventSpec.kind !== "event") return [];

  const base = {
    repoId: dependentSpec.repoId,
    specId: dependentSpec.id,
    filePath: dependentSpec.fileId,
    relationKind,
    confidence,
  };

  switch (change.changeType) {
    case "topic-removed":
      return [{
        ...base,
        severity: "breaking",
        symbol: eventSpec.topic,
        description: `Consumer subscribes to removed event topic ${eventSpec.topic}`,
        evidence: `event: ${eventSpec.topic}${eventSpec.broker ? ` (${eventSpec.broker})` : ""} (via ${relationKind}: ${reason})`,
      }];

    case "topic-renamed":
      return [{
        ...base,
        severity: "breaking",
        symbol: eventSpec.topic,
        description: `Consumer references renamed event topic ${eventSpec.topic} → ${change.detail ?? "unknown"}`,
        evidence: `event: ${eventSpec.topic} → ${change.detail} (via ${relationKind}: ${reason})`,
      }];

    case "event-payload-change":
      return [{
        ...base,
        severity: "risky",
        symbol: eventSpec.topic,
        description: `Consumer may be affected by payload change on event ${eventSpec.topic}`,
        evidence: `event: ${eventSpec.topic} payload: ${eventSpec.payloadType ?? "unknown"} (via ${relationKind})`,
      }];

    // Cross-cutting: schema field changes that affect event payloads
    case "field-removed":
      return [{
        ...base,
        severity: "risky",
        symbol: eventSpec.topic,
        description: `Event payload field '${change.detail ?? "unknown"}' removed — affects ${eventSpec.topic}`,
        evidence: `event: ${eventSpec.topic} (via EVENT_PAYLOAD)`,
      }];

    case "field-type-changed":
      return [{
        ...base,
        severity: "risky",
        symbol: eventSpec.topic,
        description: `Event payload field type changed for '${change.detail ?? "unknown"}' — affects ${eventSpec.topic}`,
        evidence: `event: ${eventSpec.topic} (via EVENT_PAYLOAD)`,
      }];

    case "field-added":
      return [{
        ...base,
        severity: "compatible",
        symbol: eventSpec.topic,
        description: `New payload field '${change.detail ?? "unknown"}' added — compatible with ${eventSpec.topic}`,
        evidence: `event: ${eventSpec.topic} (via EVENT_PAYLOAD)`,
      }];

    default:
      return [];
  }
}
