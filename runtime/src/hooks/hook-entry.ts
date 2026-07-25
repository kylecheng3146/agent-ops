import type { HookDispatchOptions, HookResult } from "./events.js";
import { dispatchHookEvent } from "./dispatch.js";
import { normalizeHookEvent } from "./normalize.js";

function invalidInput(): HookResult {
  return {
    action: "continue",
    status: "UNKNOWN",
    code: "HOOK_INPUT_INVALID"
  };
}

export async function runHookEntry(
  stdin: string,
  options: HookDispatchOptions
): Promise<HookResult> {
  let input: unknown;
  try {
    input = JSON.parse(stdin) as unknown;
    return await dispatchHookEvent(normalizeHookEvent(input), options);
  } catch {
    return invalidInput();
  }
}
