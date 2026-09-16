import { createServer } from "node:net";

/**
 * What the host this process runs inside reports or proves it may not let a
 * reviewer do.
 *
 * A reviewer CLI is spawned as a child, so it inherits whatever sandbox the
 * host applied to agent-ops itself. That makes agent-ops a faithful probe: a
 * bind it cannot perform is a bind the reviewer cannot perform either.
 */
export type HostRestriction = "none" | "bind-blocked" | "network-blocked";

export interface HostRestrictionOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Resolves true when a loopback listener could be opened. */
  readonly probeBind?: () => Promise<boolean>;
}

/** Targets that need a loopback listener of their own to answer at all. */
export const BIND_DEPENDENT_TARGETS: readonly string[] = ["agy"];

const BIND_PROBE_TIMEOUT_MS = 2_000;

/**
 * Opens and immediately closes a loopback listener on an ephemeral port.
 * Cheap enough to run before every review, and it exercises exactly the
 * capability a sandboxed host withholds.
 */
export async function probeLoopbackBind(): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = createServer();
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      server.close(() => resolve(value));
    };
    const timer = setTimeout(() => finish(false), BIND_PROBE_TIMEOUT_MS);
    timer.unref();
    server.once("error", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(false);
      }
    });
    server.listen(0, "127.0.0.1", () => finish(true));
  });
}

/**
 * The host's restriction, read from what the host publishes about itself and
 * then, when that says nothing, from what this process can actually do. Codex
 * declares both facts in the environment; nothing else does, so the probe is
 * what covers every other host.
 */
export async function detectHostRestriction(
  options: HostRestrictionOptions = {}
): Promise<HostRestriction> {
  const env = options.env ?? process.env;
  // Keep the host declaration distinct from the narrower loopback probe. The
  // executor treats this signal as advisory because a target may use a
  // transport that differs from this process.
  if (env.CODEX_SANDBOX_NETWORK_DISABLED === "1") {
    return "network-blocked";
  }
  const probe = options.probeBind ?? probeLoopbackBind;
  return (await probe()) ? "none" : "bind-blocked";
}
