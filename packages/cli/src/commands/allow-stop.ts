import { AgentOpsError } from "../../../../runtime/src/fs/paths.js";
import type { CompletionGateService } from "../../../../runtime/src/hooks/completion-gate.js";
import type { ParsedArgs } from "../args.js";
import { okEnvelope, type CliEnvelope } from "../output.js";

export async function runAllowStopCommand(options: {
  readonly args: ParsedArgs;
  readonly gate: CompletionGateService;
}): Promise<CliEnvelope<{ readonly message: string }>> {
  if (options.args.command !== "allow-stop" || options.args.sessionId === undefined) {
    throw new AgentOpsError("COMPLETION_GATE_SESSION_REQUIRED", "allow-stop requires --session.");
  }
  await options.gate.grantPermit(options.args.sessionId);
  return okEnvelope("COMPLETION_GATE_PERMIT_GRANTED", {
    message: "One Stop is permitted for this conversation and current source fingerprint."
  });
}
