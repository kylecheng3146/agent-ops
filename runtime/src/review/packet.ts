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
  for (const value of [
    input.request,
    ...input.criteria.flatMap((criterion) => [criterion.id, criterion.description, ...(criterion.verifierIds ?? [])]),
    ...input.artifactRefs,
    ...input.evidenceRequirements.flatMap((requirement) => [requirement.criterionId, requirement.requirement])
  ]) {
    checkSensitive(value);
  }
  const packet: ReviewPacket = {
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
  if (Buffer.byteLength(JSON.stringify(packet), "utf8") > MAX_PACKET_BYTES) {
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
