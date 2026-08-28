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

function evaluateCommands(
  commands: readonly {
    readonly command: string;
    readonly args: readonly string[];
  }[],
  scope: string
): HookResult {
  let warning: HookResult | null = null;
  for (const command of commands) {
    const result = guardrailResult(
      evaluateGuardrail({
        kind: "command",
        command: command.command,
        args: command.args,
        scope
      })
    );
    if (result.action === "block") {
      return result;
    }
    if (result.status === "UNKNOWN") {
      warning = result;
    }
  }
  return warning ?? continueWith("PASS", "GUARDRAIL_ALLOWED");
}

export async function dispatchHookEvent(
  event: NormalizedHookEvent,
  options: HookDispatchOptions
): Promise<HookResult> {
  if (options.completionGate !== undefined) {
    const result = await options.completionGate.handle(event);
    if (result !== null) {
      return result;
    }
  }
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
    (event.event === "command" ||
      event.event === "command-batch" ||
      event.event === "content") &&
    options.capabilities.includes("command-policy")
  ) {
    if (event.event === "content") {
      return guardrailResult(
        evaluateGuardrail({
            kind: "content",
            content: event.content,
            scope: event.scope
          })
      );
    }
    return evaluateCommands(
      event.event === "command"
        ? [{ command: event.command, args: event.args }]
        : event.commands,
      event.scope
    );
  }
  if (
    event.event === "stop" &&
    options.capabilities.includes("optional-stop-verify")
  ) {
    if (options.stopVerification === undefined) {
      return continueWith("UNKNOWN", "STOP_VERIFICATION_UNAVAILABLE");
    }
    return await runStopVerification({
      ...options.stopVerification,
      trusted: options.trusted && options.stopVerification.trusted
    });
  }
  return continueWith("PASS", "HOOK_NOOP");
}
