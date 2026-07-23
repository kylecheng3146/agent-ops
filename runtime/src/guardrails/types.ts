import type { SecurityException } from "../contracts.js";

export const GUARDRAIL_RULE_IDS = {
  ambiguousTarget: "destructive-ambiguous-target",
  broadDelete: "destructive-broad-delete",
  credential: "secret-credential",
  forcePush: "destructive-force-push",
  privateKey: "secret-private-key",
  reset: "destructive-reset"
} as const;

export type GuardrailRuleId =
  (typeof GUARDRAIL_RULE_IDS)[keyof typeof GUARDRAIL_RULE_IDS];

export type GuardrailDecision =
  | { action: "allow" }
  | { action: "warn"; ruleId: string; reason: string }
  | {
      action: "block";
      ruleId: string;
      reason: string;
      saferAlternative?: string;
    };

interface GuardrailInputBase {
  readonly scope: string;
}

export interface ContentGuardrailInput extends GuardrailInputBase {
  readonly kind: "content";
  readonly content: string;
}

export interface CommandGuardrailInput extends GuardrailInputBase {
  readonly kind: "command";
  readonly command: string;
  readonly args: readonly string[];
}

export type GuardrailInput = ContentGuardrailInput | CommandGuardrailInput;

export interface GuardrailEvaluationOptions {
  readonly exceptions?: readonly SecurityException[];
  readonly now?: Date;
  readonly clock?: () => Date;
}
