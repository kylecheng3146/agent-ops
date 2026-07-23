import { evaluateDestructiveCommand } from "./destructive.js";
import { applySecurityExceptions } from "./exceptions.js";
import { evaluateSecretContent } from "./secrets.js";
import type {
  GuardrailDecision,
  GuardrailEvaluationOptions,
  GuardrailInput
} from "./types.js";

export function evaluateGuardrail(
  input: GuardrailInput,
  options: GuardrailEvaluationOptions = {}
): GuardrailDecision {
  const decision =
    input.kind === "content"
      ? evaluateSecretContent(input.content)
      : evaluateDestructiveCommand(input);
  return applySecurityExceptions(decision, input.scope, options);
}
