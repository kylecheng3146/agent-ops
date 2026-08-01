import { homedir } from "node:os";
import { join } from "node:path";

import type { SessionStartHookEvent } from "./events.js";
import { appendLocalLog } from "../logging/local-log.js";
import { localStatePaths } from "../security/permissions.js";

export interface LifecycleAdvisoryOptions {
  readonly homeDirectory?: string;
  readonly now?: string;
}

/**
 * Records the bounded lifecycle summary signal locally. It deliberately does
 * not include project paths, prompts, commands, or verification evidence.
 */
export async function runLifecycleAdvisory(
  _event: SessionStartHookEvent,
  options: LifecycleAdvisoryOptions = {}
): Promise<void> {
  const home =
    options.homeDirectory ?? process.env.AGENT_OPS_HOME ?? homedir();
  const state = localStatePaths(home);
  await appendLocalLog(
    join(state.logDirectory, "events.ndjson"),
    { type: "diagnostic", code: "LIFECYCLE_SUMMARY" },
    {
      anchorDirectory: state.anchorDirectory,
      ...(options.now === undefined ? {} : { now: options.now })
    }
  );
}
