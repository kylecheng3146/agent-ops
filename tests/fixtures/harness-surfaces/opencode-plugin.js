// Managed by agent-ops. Do not edit: `agent-ops update` rewrites this file.
const MARKER = "--managed-by=agent-ops";
async function runManagedHook() {
  return MARKER;
}
export const AgentOps = async () => {
  await runManagedHook();
  const hooks = {};
  hooks["tool.execute.before"] = async () => {
    await runManagedHook($, "PreToolUse");
  };
  hooks.event = async () => {
    if (event?.type !== "session.idle") return;
    await runManagedHook($, "Stop");
  };
  return hooks;
};
