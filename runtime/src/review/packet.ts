export interface ReviewCriterion {
  readonly id: string;
  readonly description: string;
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

export function buildReviewPacket(input: ReviewPacketInput): ReviewPacket {
  return {
    request: input.request,
    criteria: input.criteria.map((criterion) => ({ ...criterion })),
    artifactRefs: [...input.artifactRefs],
    evidenceRequirements: input.evidenceRequirements.map((requirement) => ({
      ...requirement
    }))
  };
}
