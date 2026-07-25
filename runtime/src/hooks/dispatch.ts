import { evaluateGuardrail } from "../guardrails/evaluate.js";
import type { GuardrailDecision } from "../guardrails/types.js";
import type {
  HookDispatchOptions,
  HookResult,
  NormalizedHookEvent
} from "./events.js";
import { runStopVerification } from "./stop-verify.js";

function continueWith(
  status: HookResult["status"],
  code: string
): HookResult {
  return { action: "continue", status, code };
}

function guardrailResult(decision: GuardrailDecision): HookResult {
  if (decision.action === "block") {
    return {
      action: "block",
      status: "FAIL",
      code: decision.ruleId
    };
  }
  if (decision.action === "warn") {
    return continueWith("UNKNOWN", decision.ruleId);
  }
  return continueWith("PASS", "GUARDRAIL_ALLOWED");
}

export async function dispatchHookEvent(
  event: NormalizedHookEvent,
  options: HookDispatchOptions
): Promise<HookResult> {
  if (event.event === "unsupported") {
    return continueWith("UNKNOWN", "HOOK_EVENT_UNSUPPORTED");
  }
  if (
    event.event === "session-start" &&
    options.capabilities.includes("lifecycle-summary") &&
    options.advisory !== undefined
  ) {
    try {
      await options.advisory(event);
      return continueWith("PASS", "ADVISORY_FINISHED");
    } catch {
      return continueWith("UNKNOWN", "ADVISORY_FAILED");
    }
  }
  if (
    (event.event === "command" || event.event === "content") &&
    options.capabilities.includes("command-policy")
  ) {
    return guardrailResult(
      event.event === "command"
        ? evaluateGuardrail({
            kind: "command",
            command: event.command,
            args: event.args,
            scope: event.scope
          })
        : evaluateGuardrail({
            kind: "content",
            content: event.content,
            scope: event.scope
          })
    );
  }
  if (
    event.event === "stop" &&
    options.capabilities.includes("optional-stop-verify")
  ) {
    if (options.stopVerification === undefined) {
      return continueWith("UNKNOWN", "STOP_VERIFICATION_UNAVAILABLE");
    }
    return await runStopVerification(options.stopVerification);
  }
  return continueWith("PASS", "HOOK_NOOP");
}
