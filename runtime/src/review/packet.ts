export interface ReviewCriterion {
  readonly id: string;
  readonly description: string;
  /** Verifiers that already cover this criterion mechanically, if any. */
  readonly verifierIds?: readonly string[];
}

export interface ReviewEvidenceRequirement {
  readonly criterionId: string;
  readonly requirement: string;
}

export interface ReviewPacket {
  readonly contractArtifacts?: readonly {readonly path: string; readonly digest: string; readonly content: string}[];
  readonly contractManifest?: {readonly path: string; readonly digest: string; readonly content: string};
  readonly request: string;
  readonly criteria: readonly ReviewCriterion[];
  readonly artifactRefs: readonly string[];
  readonly evidenceRequirements: readonly ReviewEvidenceRequirement[];
}

export interface ReviewPacketInput extends ReviewPacket {
  readonly implementationRationale?: string;
  readonly rawLogs?: string;
  readonly credential?: string;
}

const MAX_PACKET_BYTES = 64 * 1024;

/** Keep artifact contents for snapshots; reference an exact sealed index once in prompts. */
export function reviewPacketData(packet: ReviewPacket) {
  const artifacts = packet.contractArtifacts?.map(({path, digest}) => ({path, digest}));
  let indexed = false;
  if (packet.contractManifest !== undefined && artifacts !== undefined) {
    try {
      const manifest = JSON.parse(packet.contractManifest.content) as {artifacts?: unknown} | null;
      indexed = JSON.stringify(manifest?.artifacts) === JSON.stringify(artifacts);
    } catch { /* Legacy manifests keep inline artifact metadata. */ }
  }
  return {...packet, contractArtifacts: indexed ? undefined : artifacts,
    contractManifest: packet.contractManifest === undefined ? undefined : {path: packet.contractManifest.path, digest: packet.contractManifest.digest}};
}

function safe(value: string): string {
  return safeTaskText(redactSecrets(value));
}

function checkSensitive(value: string): void {
  const decision = evaluateGuardrail({
    kind: "content",
    content: value,
    scope: "review-packet"
  });
  if (decision.action === "block") {
    throw new AgentOpsError(
      "REVIEW_SENSITIVE_INPUT",
      "Review input contains credential-shaped content."
    );
  }
}

export function buildReviewPacket(input: ReviewPacketInput): ReviewPacket {
  if (input.contractManifest !== undefined) {
    checkSensitive(input.contractManifest.content);
    if (Buffer.byteLength(input.contractManifest.content, "utf8") > 512 * 1024 ||
        sha256(input.contractManifest.content) !== input.contractManifest.digest ||
        input.contractManifest.path !== ".agent-ops/tasks/review-contracts/" + input.contractManifest.digest + ".json")
      throw new AgentOpsError("REVIEW_SCOPE_TOO_LARGE", "Contract manifest is invalid or exceeds 512 KiB.");
  }
  if (input.contractArtifacts !== undefined) {
    if (input.contractArtifacts.length > 512 || input.contractArtifacts.reduce((size, artifact) => size + Buffer.byteLength(artifact.content), 0) > 16 * 1024 * 1024)
      throw new AgentOpsError("REVIEW_SCOPE_TOO_LARGE", "Contract artifacts exceed the bounded snapshot scope.");
    for (const artifact of input.contractArtifacts) {
      checkSensitive(artifact.content);
      if (!/^\.agent-ops\/tasks\/(?:acceptance\/[a-f0-9]{64}\.json|evidence\/[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*-[a-f0-9]{16}\.json)$/u.test(artifact.path) ||
          sha256(artifact.content) !== artifact.digest || Buffer.byteLength(artifact.content) > 4 * 1024 * 1024)
        throw new AgentOpsError("REVIEW_SCOPE_TOO_LARGE", "Contract artifact is invalid or too large.");
    }
  }
  for (const value of [
    input.request,
    ...input.criteria.flatMap((criterion) => [criterion.id, criterion.description, ...(criterion.verifierIds ?? [])]),
    ...input.artifactRefs,
    ...input.evidenceRequirements.flatMap((requirement) => [requirement.criterionId, requirement.requirement])
  ]) {
    checkSensitive(value);
  }
  const packet: ReviewPacket = {
    ...(input.contractArtifacts === undefined ? {} : {contractArtifacts: input.contractArtifacts}),
    ...(input.contractManifest === undefined ? {} : {contractManifest: input.contractManifest}),
    request: safe(input.request),
    criteria: input.criteria.map((criterion) => ({
      id: safe(criterion.id),
      description: safe(criterion.description),
      ...(criterion.verifierIds === undefined
        ? {}
        : { verifierIds: criterion.verifierIds.map(safe) })
    })),
    artifactRefs: input.artifactRefs.map(safe),
    evidenceRequirements: input.evidenceRequirements.map((requirement) => ({
      criterionId: safe(requirement.criterionId),
      requirement: safe(requirement.requirement)
    }))
  };
  if (Buffer.byteLength(JSON.stringify(reviewPacketData(packet)), "utf8") > MAX_PACKET_BYTES) {
    throw new AgentOpsError(
      "REVIEW_SCOPE_TOO_LARGE",
      "Review packet exceeds the 64 KiB limit."
    );
  }
  return packet;
}
import { evaluateGuardrail } from "../guardrails/evaluate.js";
import { AgentOpsError } from "../fs/paths.js";
import { redactSecrets } from "../security/redact.js";
import { safeTaskText } from "../task/render.js";

import {sha256} from "../fs/hash.js";
