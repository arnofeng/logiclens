import type { ContractSpecNode, SemanticRelationEdge } from "../../parsing/types.js";
import type { SpecRoleMap } from "./types.js";
import { deserializeSpec } from "../spec.js";
import type { EventSpec } from "../spec.js";

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Matches event ContractSpecs by canonical topic across repos.
 *
 * For each topic, producer→consumer pairs produce:
 *   - PUBLISHES_EVENT  (producer → consumer)
 *   - SUBSCRIBES_EVENT (consumer → producer)
 *
 * Payload compatibility is checked: if both sides name a payload type and they
 * differ, confidence is slightly downgraded.
 */
export function resolveEventRelations(
  specs: ContractSpecNode[],
  specRoles: SpecRoleMap
): SemanticRelationEdge[] {
  const eventSpecs = specs.filter((s) => s.specKind === "event");
  if (eventSpecs.length < 2) return [];

  // Group by canonical topic (eventTopic column)
  const byTopic = new Map<string, ContractSpecNode[]>();
  for (const spec of eventSpecs) {
    const topic = spec.eventTopic ?? parseEventSpec(spec).topic;
    if (!topic) continue;
    const list = byTopic.get(topic);
    if (list) {
      list.push(spec);
    } else {
      byTopic.set(topic, [spec]);
    }
  }

  const edges: SemanticRelationEdge[] = [];
  const seen = new Set<string>();

  for (const [, topicSpecs] of byTopic) {
    if (topicSpecs.length < 2) continue;

    // Partition by role within this topic
    const producers: ContractSpecNode[] = [];
    const consumers: ContractSpecNode[] = [];

    for (const spec of topicSpecs) {
      const role = specRoles.get(`${spec.contractId}:${spec.repoId}`) ?? "shared";
      if (role === "producer" || role === "owner") {
        producers.push(spec);
      }
      if (role === "consumer" || role === "shared") {
        consumers.push(spec);
      }
      // "shared" participates as both
      if (role === "shared" && !producers.includes(spec)) {
        producers.push(spec);
      }
    }

    for (const producer of producers) {
      for (const consumer of consumers) {
        // Skip same spec
        if (producer.id === consumer.id) continue;
        // Skip same repo
        if (producer.repoId === consumer.repoId) continue;

        const producerPayload = parseEventSpec(producer).payloadType;
        const consumerPayload = parseEventSpec(consumer).payloadType;

        let confidence = 0.95; // exact topic match
        let reason = `Topic match: ${producer.eventTopic ?? parseEventSpec(producer).topic}`;

        if (producerPayload && consumerPayload && producerPayload !== consumerPayload) {
          confidence = 0.85;
          reason += `; payload differs (producer=${producerPayload}, consumer=${consumerPayload})`;
        }

        // PUBLISHES_EVENT: producer → consumer
        const pubKey = `${producer.id}:${consumer.id}:PUBLISHES_EVENT`;
        if (!seen.has(pubKey)) {
          seen.add(pubKey);
          edges.push({
            fromSpecId: producer.id,
            toSpecId: consumer.id,
            kind: "PUBLISHES_EVENT",
            evidenceId: producer.evidenceId,
            reason,
            confidence
          });
        }

        // SUBSCRIBES_EVENT: consumer → producer
        const subKey = `${consumer.id}:${producer.id}:SUBSCRIBES_EVENT`;
        if (!seen.has(subKey)) {
          seen.add(subKey);
          edges.push({
            fromSpecId: consumer.id,
            toSpecId: producer.id,
            kind: "SUBSCRIBES_EVENT",
            evidenceId: consumer.evidenceId,
            reason: `Subscribes to ${producer.eventTopic ?? parseEventSpec(producer).topic}`,
            confidence
          });
        }
      }
    }
  }

  return edges;
}

function parseEventSpec(spec: ContractSpecNode): EventSpec {
  return deserializeSpec(spec.specJson) as EventSpec;
}
