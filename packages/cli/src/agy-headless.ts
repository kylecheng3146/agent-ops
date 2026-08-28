import type { CompletionGateService } from "../../../runtime/src/hooks/completion-gate.js";

export interface AgyHeadlessOptions {
  readonly root: string;
  readonly sessionId: string;
  readonly args: readonly string[];
  readonly gate: CompletionGateService;
  readonly run: (
    args: readonly string[],
    env: NodeJS.ProcessEnv
  ) => Promise<number>;
  readonly env?: NodeJS.ProcessEnv;
}

/** Headless wrapper: native Stop is bounded by agy, process exit is not. */
export async function runAgyHeadless(
  options: AgyHeadlessOptions
): Promise<number> {
  await options.gate.initialize(options.sessionId);
  const exitCode = await options.run(options.args, {
    ...(options.env ?? process.env),
    AGENT_OPS_SESSION_ID: options.sessionId
  });
  if (exitCode !== 0) return exitCode;
  const result = await options.gate.handle({
    event: "stop",
    projectRoot: options.root,
    sessionId: options.sessionId,
    terminationReason: "model_stop",
    fullyIdle: true
  });
  return result?.action === "block" ? 2 : 0;
}
