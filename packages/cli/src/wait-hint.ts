import { join } from "node:path";
import { readPrivateFile, writePrivateFile } from "../../../runtime/src/security/permissions.js";

/** The long-running commands an agent should wait for in one step. */
export type WaitKind = "verify" | "review" | "batch";

/** Display-only last elapsed time per command, shared by every worktree of the repository; never evidence. */
export function durationsPath(commonDir: string): string {
  return join(commonDir, "agent-ops", "durations.json");
}

export function waitHint(kind: WaitKind, lastMs?: number): string {
  const last = lastMs === undefined ? "" : ` Last ${kind} here took about ${Math.max(1, Math.round(lastMs / 60_000))} min.`;
  return `agent-ops: ${kind} runs until it exits.${last} Wait for the process to exit in one step; do not poll it or send status-only messages.`;
}

async function readDurations(commonDir: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse((await readPrivateFile(durationsPath(commonDir), commonDir)) ?? "{}");
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * JSON mode prints no hint: callers that join stdout and stderr read the envelope from the last line.
 * Anything else gets the default stderr writer.
 */
export function hintWriter(json: boolean | undefined): ((line: string) => void) | undefined {
  return json === true ? () => undefined : undefined;
}

/**
 * Prints the wait line on stderr before `work`, then records how long `work` took.
 * Every hint failure is swallowed: the command's result, exit code and stdout never depend on it.
 */
export async function withWaitHint<T>(
  commonDir: string | undefined,
  kind: WaitKind,
  work: () => Promise<T>,
  write: (line: string) => void = line => { process.stderr.write(line); },
  now: () => number = Date.now
): Promise<T> {
  const last = commonDir === undefined ? undefined : (await readDurations(commonDir))[kind];
  try {
    write(waitHint(kind, typeof last === "number" && Number.isFinite(last) && last > 0 ? last : undefined) + "\n");
  } catch { /* display only */ }
  const started = now();
  const result = await work();
  if (commonDir !== undefined) {
    // Re-read so another worktree's update to a different command survives; last writer wins per command.
    try {
      await writePrivateFile(durationsPath(commonDir),
        JSON.stringify({...await readDurations(commonDir), [kind]: now() - started}) + "\n", commonDir);
    } catch { /* display only */ }
  }
  return result;
}
