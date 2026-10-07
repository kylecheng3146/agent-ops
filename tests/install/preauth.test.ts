import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { parseArgs } from "../../packages/cli/src/args.js";
import { runInitCommand } from "../../packages/cli/src/commands/init.js";
import { runUninstallCommand } from "../../packages/cli/src/commands/uninstall.js";
import { commonHarnessAdapters } from "../../runtime/src/install/harness.js";
import { applyUpdatePlan, createUpdatePlan } from "../../runtime/src/install/update.js";
import {
  applyPreauth,
  CLAUDE_LOCAL_SETTINGS_PATH,
  CLAUDE_PREAUTH_ALLOW,
  CLAUDE_PREAUTH_RUN_ALLOW,
  CLAUDE_PREAUTH_RUN_UNSANDBOXED,
  CLAUDE_PREAUTH_UNSANDBOXED,
  CODEX_RULES_CONTENT,
  codexRulesContent,
  CODEX_RULES_MARKER,
  CODEX_RULES_PATH,
  planClaudeLocalSettings,
  planPreauth
} from "../../runtime/src/install/preauth.js";

const run = promisify(execFile);

async function scratch(): Promise<{ root: string; codexHome: string }> {
  const base = await mkdtemp(join(tmpdir(), "agent-ops-preauth-"));
  const root = join(base, "project");
  const codexHome = join(base, "codex");
  await mkdir(root, { recursive: true });
  await mkdir(join(codexHome, "rules"), { recursive: true });
  return { root, codexHome };
}

const USER_SETTINGS = {
  permissions: { allow: ["Bash(npm test *)"], deny: ["Bash(rm -rf *)"] },
  env: { API_TOKEN: "sk-do-not-print-this-value-0123456789" },
  sandbox: { enabled: true, excludedCommands: ["docker"] }
};

test("the managed entries are merged in beside the user's own and leave the rest of the file alone", () => {
  const planned = planClaudeLocalSettings(JSON.stringify(USER_SETTINGS), true);
  assert.notEqual(planned, undefined);
  const settings = JSON.parse(planned?.content ?? "") as typeof USER_SETTINGS & {
    permissions: { allow: string[]; deny: string[] };
    sandbox: { enabled: boolean; excludedCommands: string[] };
  };
  assert.deepEqual(settings.permissions.allow, ["Bash(npm test *)", ...CLAUDE_PREAUTH_ALLOW]);
  assert.deepEqual(settings.permissions.deny, ["Bash(rm -rf *)"]);
  assert.deepEqual(settings.sandbox.excludedCommands, ["docker", ...CLAUDE_PREAUTH_UNSANDBOXED]);
  assert.equal(settings.sandbox.enabled, true);
  assert.deepEqual(settings.env, USER_SETTINGS.env);
  // A second pass changes nothing.
  assert.equal(planClaudeLocalSettings(planned?.content ?? null, true), undefined);
});

test("nothing that only the user may approve is pre-authorized", () => {
  for (const entry of CLAUDE_PREAUTH_ALLOW) {
    assert.doesNotMatch(entry, /trust|allow-stop|init|update|uninstall|config/u, entry);
    assert.match(
      entry,
      /^(Bash\(agent-ops (task|verify|review|batch|worktree|doctor) \*\)|EnterWorktree|Bash\(npx lint-staged \*\))$/u,
      entry
    );
  }
});

test("a worktree session commits and enters its worktree without a prompt", () => {
  assert.ok(CLAUDE_PREAUTH_ALLOW.includes("EnterWorktree"));
  assert.ok(CLAUDE_PREAUTH_ALLOW.includes("Bash(npx lint-staged *)"));
  for (const entry of ["agent-ops worktree commit *", "npx lint-staged *"]) {
    assert.ok(CLAUDE_PREAUTH_UNSANDBOXED.includes(entry), entry);
  }
  assert.match(CODEX_RULES_CONTENT, /pattern = \["agent-ops", "worktree", "commit"\]/u);
  assert.match(CODEX_RULES_CONTENT, /pattern = \["npx", "lint-staged"\]/u);
});

test("removal strips exactly the managed entries, and removes a file that held nothing else", () => {
  const withManaged = planClaudeLocalSettings(JSON.stringify(USER_SETTINGS), true)?.content ?? "";
  const stripped = planClaudeLocalSettings(withManaged, false);
  assert.deepEqual(JSON.parse(stripped?.content ?? ""), USER_SETTINGS);

  const only = planClaudeLocalSettings(null, true)?.content ?? "";
  assert.deepEqual(planClaudeLocalSettings(only, false), { content: null });
  assert.equal(planClaudeLocalSettings(null, false), undefined);
  assert.equal(planClaudeLocalSettings(JSON.stringify(USER_SETTINGS), false), undefined);
});

test("update-adds-batch: an install holding the old review-only entries gains the batch entries once", async () => {
  const oldAllow = ["Bash(agent-ops task *)", "Bash(agent-ops verify *)", "Bash(agent-ops review *)", "Bash(agent-ops worktree *)", "Bash(agent-ops doctor *)"];
  const old = {
    permissions: { allow: ["Bash(npm test *)", ...oldAllow], deny: ["Bash(rm -rf *)"] },
    sandbox: { enabled: true, excludedCommands: ["docker", "agent-ops review", "agent-ops review *"] }
  };
  const planned = planClaudeLocalSettings(JSON.stringify(old), true);
  assert.notEqual(planned, undefined);
  const settings = JSON.parse(planned?.content ?? "") as typeof old;
  for (const entry of ["Bash(agent-ops batch *)"]) {
    assert.equal(settings.permissions.allow.filter((value) => value === entry).length, 1, entry);
  }
  for (const entry of ["agent-ops batch", "agent-ops batch *"]) {
    assert.equal(settings.sandbox.excludedCommands.filter((value) => value === entry).length, 1, entry);
  }
  assert.ok(settings.permissions.allow.includes("Bash(npm test *)"));
  assert.ok(settings.sandbox.excludedCommands.includes("docker"));
  assert.deepEqual(settings.permissions.deny, ["Bash(rm -rf *)"]);
  assert.equal(new Set(settings.permissions.allow).size, settings.permissions.allow.length);
  assert.equal(new Set(settings.sandbox.excludedCommands).size, settings.sandbox.excludedCommands.length);
  assert.equal(planClaudeLocalSettings(planned?.content ?? null, true), undefined, "a second update changes nothing");

  // A rules file agent-ops wrote before batch existed is regenerated, then left alone.
  const { root, codexHome } = await scratch();
  try {
    const path = join(codexHome, CODEX_RULES_PATH);
    await writeFile(path, `${CODEX_RULES_MARKER}\n# stale: review only\n`);
    const change = await planPreauth({ root, scope: "project", harness: ["codex"], desired: true, codexHome });
    assert.equal(change.length, 1);
    await applyPreauth(change);
    assert.equal(await readFile(path, "utf8"), CODEX_RULES_CONTENT);
    assert.deepEqual(await planPreauth({ root, scope: "project", harness: ["codex"], desired: true, codexHome }), []);
  } finally {
    await rm(join(root, ".."), { recursive: true, force: true });
  }
});

test("settings that cannot be merged safely are refused, not rewritten", () => {
  for (const source of ["{not json", "[]", '{"permissions":[]}', '{"permissions":{"allow":"Bash(x)"}}']) {
    assert.throws(() => planClaudeLocalSettings(source, true), { code: "PREAUTH_SETTINGS_INVALID" }, source);
  }
});

test("planning and applying writes Claude's local settings once and takes them back out", async () => {
  const { root, codexHome } = await scratch();
  try {
    await mkdir(join(root, ".claude"), { recursive: true });
    await writeFile(join(root, CLAUDE_LOCAL_SETTINGS_PATH), JSON.stringify(USER_SETTINGS));

    const first = await planPreauth({ root, scope: "project", harness: ["claude"], desired: true, codexHome });
    assert.equal(first.length, 1);
    assert.equal(first[0]?.ownedContent, false);
    await applyPreauth(first);
    assert.deepEqual(await planPreauth({ root, scope: "project", harness: ["claude"], desired: true, codexHome }), []);

    const off = await planPreauth({ root, scope: "project", harness: ["claude"], desired: false, codexHome });
    await applyPreauth(off);
    assert.deepEqual(JSON.parse(await readFile(join(root, CLAUDE_LOCAL_SETTINGS_PATH), "utf8")), USER_SETTINGS);

    // Project scope only.
    assert.deepEqual(await planPreauth({ root, scope: "user", harness: ["claude"], desired: true, codexHome }), []);
  } finally {
    await rm(join(root, ".."), { recursive: true, force: true });
  }
});

test("Codex rules are written once, only when Codex's home is named, and never over a file agent-ops did not write", async () => {
  const { root, codexHome } = await scratch();
  try {
    assert.deepEqual(await planPreauth({ root, scope: "project", harness: ["codex"], desired: true }), []);
    assert.deepEqual(
      await planPreauth({ root, scope: "project", harness: ["codex"], desired: true, codexHome: join(root, "missing") }),
      []
    );

    const first = await planPreauth({ root, scope: "project", harness: ["codex"], desired: true, codexHome });
    assert.equal(first.length, 1);
    assert.equal(first[0]?.ownedContent, true);
    await applyPreauth(first);
    const path = join(codexHome, CODEX_RULES_PATH);
    assert.equal(await readFile(path, "utf8"), CODEX_RULES_CONTENT);
    assert.deepEqual(await planPreauth({ root, scope: "project", harness: ["codex"], desired: true, codexHome }), []);

    await applyPreauth(await planPreauth({ root, scope: "project", harness: ["codex"], desired: false, codexHome }));
    await assert.rejects(readFile(path, "utf8"), { code: "ENOENT" });

    await writeFile(path, "# my own rules\n");
    assert.deepEqual(await planPreauth({ root, scope: "project", harness: ["codex"], desired: true, codexHome }), []);
    assert.deepEqual(await planPreauth({ root, scope: "project", harness: ["codex"], desired: false, codexHome }), []);
    assert.equal(await readFile(path, "utf8"), "# my own rules\n");
  } finally {
    await rm(join(root, ".."), { recursive: true, force: true });
  }
});

test("the rules cover review, batch, advance and the auth probe", async (t) => {
  assert.ok(CODEX_RULES_CONTENT.startsWith(CODEX_RULES_MARKER));
  assert.equal(CODEX_RULES_CONTENT.match(/^prefix_rule\(/gmu)?.length, 10);
  // batch, like review, is allowed with and without AGENT_OPS_HOST.
  assert.equal(CODEX_RULES_CONTENT.match(/"agent-ops", "batch"\]/gu)?.length, 2);
  assert.equal(CODEX_RULES_CONTENT.match(/"agent-ops", "review"\]/gu)?.length, 2);
  assert.equal(CODEX_RULES_CONTENT.match(/"agent-ops", "task", "advance"\]/gu)?.length, 2);
  assert.match(CODEX_RULES_CONTENT, /"AGENT_OPS_HOST=codex", "AGENT_OPS_HOST=claude", "AGENT_OPS_HOST=agy"/u);
  assert.doesNotMatch(CODEX_RULES_CONTENT.replace(/not_match = .*/gu, ""), /trust|allow-stop|complete/u);

  // When Codex itself is installed, let it judge the file: it also runs every
  // match / not_match example while loading.
  const { root, codexHome } = await scratch();
  try {
    const file = join(codexHome, CODEX_RULES_PATH);
    await writeFile(file, CODEX_RULES_CONTENT);
    const check = async (...command: string[]) => JSON.parse(
      (await run("codex", ["execpolicy", "check", "--rules", file, ...command])).stdout
    ) as { decision?: string };
    try {
      await run("codex", ["--version"]);
    } catch {
      t.skip("codex is not installed");
      return;
    }
    const prefix = ["env", "-u", "CODEX_SANDBOX_NETWORK_DISABLED"];
    assert.equal((await check(...prefix, "AGENT_OPS_HOST=codex", "agent-ops", "review", "--task", "task-1", "--yes", "--output", "/tmp/r.json")).decision, "allow");
    assert.equal((await check(...prefix, "agent-ops", "doctor", "--check-auth", "--json")).decision, "allow");
    assert.equal((await check(...prefix, "AGENT_OPS_HOST=claude", "agent-ops", "batch", "--parent", "task-1", "--yes", "--output", "/tmp/b.json")).decision, "allow");
    assert.equal((await check(...prefix, "agent-ops", "batch", "--parent", "task-1", "--yes")).decision, "allow");
    assert.equal((await check("agent-ops", "worktree", "commit", "-m", "feat: x")).decision, "allow");
    assert.equal((await check("npx", "lint-staged", "--debug")).decision, "allow");
    assert.equal((await check("agent-ops", "worktree", "finish", "x")).decision, undefined);
    assert.equal((await check(...prefix, "AGENT_OPS_HOST=codex", "agent-ops", "trust", "grant", "--scope", "project", "--yes")).decision, undefined);
  } finally {
    await rm(join(root, ".."), { recursive: true, force: true });
  }
});

test("init previews the pre-authorization without printing the user's settings, applies it, and uninstall takes it back", async () => {
  const { root, codexHome } = await scratch();
  try {
    await writeFile(join(codexHome, "rules", "default.rules"), "# the user's own\n");
    await mkdir(join(root, ".claude"), { recursive: true });
    await writeFile(join(root, CLAUDE_LOCAL_SETTINGS_PATH), JSON.stringify(USER_SETTINGS));
    const initArgv = ["init", "--scope", "project", "--harness", "claude,codex", "--profile", "core", "--worktree", "auto"];
    const base = { root, adapters: commonHarnessAdapters(), isTTY: false, codexHome, confirm: async () => true };

    const dry = await runInitCommand({ ...base, args: parseArgs([...initArgv, "--dry-run"]) });
    assert.equal(dry.status, "ok");
    const planned = JSON.stringify(dry.data?.plan.operations);
    assert.match(planned, /agent-ops\.rules/u);
    assert.match(planned, /permissions\.allow/u);
    assert.doesNotMatch(planned + (dry.data?.text ?? ""), /sk-do-not-print-this-value/u);
    await assert.rejects(readFile(join(codexHome, CODEX_RULES_PATH), "utf8"), { code: "ENOENT" });

    const applied = await runInitCommand({ ...base, args: parseArgs([...initArgv, "--yes"]) });
    assert.equal(applied.status, "ok");
    const settings = JSON.parse(await readFile(join(root, CLAUDE_LOCAL_SETTINGS_PATH), "utf8")) as {
      permissions: { allow: string[] };
      env: unknown;
    };
    assert.deepEqual(settings.permissions.allow, ["Bash(npm test *)", ...CLAUDE_PREAUTH_ALLOW]);
    assert.deepEqual(settings.env, USER_SETTINGS.env);
    assert.equal(await readFile(join(codexHome, CODEX_RULES_PATH), "utf8"), CODEX_RULES_CONTENT);
    assert.equal(await readFile(join(codexHome, "rules", "default.rules"), "utf8"), "# the user's own\n");

    const removed = await runUninstallCommand({
      args: parseArgs(["uninstall", "--yes"]),
      root,
      isTTY: false,
      codexHome,
      confirm: async () => true
    });
    assert.equal(removed.status, "ok");
    assert.deepEqual(JSON.parse(await readFile(join(root, CLAUDE_LOCAL_SETTINGS_PATH), "utf8")), USER_SETTINGS);
    await assert.rejects(readFile(join(codexHome, CODEX_RULES_PATH), "utf8"), { code: "ENOENT" });
    assert.equal(await readFile(join(codexHome, "rules", "default.rules"), "utf8"), "# the user's own\n");
  } finally {
    await rm(join(root, ".."), { recursive: true, force: true });
  }
});

test("turning worktree auto off through update takes the pre-authorization back out", async () => {
  const { root, codexHome } = await scratch();
  try {
    await writeFile(join(root, "package-lock.json"), "{}");
    const base = { root, adapters: commonHarnessAdapters(), isTTY: false, codexHome, confirm: async () => true };
    await runInitCommand({
      ...base,
      args: parseArgs(["init", "--scope", "project", "--harness", "claude,codex", "--profile", "core", "--worktree", "auto", "--yes"])
    });
    assert.equal(await readFile(join(codexHome, CODEX_RULES_PATH), "utf8"), CODEX_RULES_CONTENT);

    const plan = await createUpdatePlan({
      root,
      adapters: commonHarnessAdapters(),
      targetVersion: "0.4.0",
      codexHome,
      worktree: { mode: "off" }
    });
    assert.deepEqual(
      plan.installation.preauthorization?.map(({ operation }) => operation.kind).sort(),
      ["remove", "remove"]
    );
    await applyUpdatePlan(root, plan);
    await assert.rejects(readFile(join(root, CLAUDE_LOCAL_SETTINGS_PATH), "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(join(codexHome, CODEX_RULES_PATH), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(join(root, ".."), { recursive: true, force: true });
  }
});

test("without worktree auto, init writes no pre-authorization at all", async () => {
  const { root, codexHome } = await scratch();
  try {
    const result = await runInitCommand({
      args: parseArgs(["init", "--scope", "project", "--harness", "claude,codex", "--profile", "core", "--yes"]),
      root,
      adapters: commonHarnessAdapters(),
      isTTY: false,
      codexHome,
      confirm: async () => true
    });
    assert.equal(result.status, "ok");
    await assert.rejects(readFile(join(root, CLAUDE_LOCAL_SETTINGS_PATH), "utf8"), { code: "ENOENT" });
    await assert.rejects(readFile(join(codexHome, CODEX_RULES_PATH), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(join(root, ".."), { recursive: true, force: true });
  }
});

test("the run profile adds agent-ops run to both hosts, and dropping it takes only that back", async (t) => {
  assert.deepEqual(CLAUDE_PREAUTH_RUN_ALLOW, ["Bash(agent-ops run *)"]);
  assert.deepEqual(CLAUDE_PREAUTH_RUN_UNSANDBOXED, ["agent-ops run", "agent-ops run *"]);
  const withRun = planClaudeLocalSettings(JSON.stringify(USER_SETTINGS), true, true)?.content ?? "";
  const settings = JSON.parse(withRun) as { permissions: { allow: string[] }; sandbox: { excludedCommands: string[] } };
  assert.deepEqual(settings.permissions.allow, ["Bash(npm test *)", ...CLAUDE_PREAUTH_ALLOW, ...CLAUDE_PREAUTH_RUN_ALLOW]);
  assert.deepEqual(settings.sandbox.excludedCommands, ["docker", ...CLAUDE_PREAUTH_UNSANDBOXED, ...CLAUDE_PREAUTH_RUN_UNSANDBOXED]);
  assert.equal(planClaudeLocalSettings(withRun, true, true), undefined, "a second update changes nothing");
  // An update without the profile keeps the rest and strips only the run entries.
  assert.equal(planClaudeLocalSettings(withRun, true)?.content, planClaudeLocalSettings(JSON.stringify(USER_SETTINGS), true)?.content);
  assert.deepEqual(JSON.parse(planClaudeLocalSettings(withRun, false)?.content ?? ""), USER_SETTINGS);
  // Without worktree auto mode, the profile grants run alone, never the worktree set.
  const runOnly = JSON.parse(planClaudeLocalSettings(JSON.stringify(USER_SETTINGS), false, true)?.content ?? "") as typeof settings;
  assert.deepEqual(runOnly.permissions.allow, ["Bash(npm test *)", ...CLAUDE_PREAUTH_RUN_ALLOW]);
  assert.deepEqual(runOnly.sandbox.excludedCommands, ["docker", ...CLAUDE_PREAUTH_RUN_UNSANDBOXED]);

  assert.equal(codexRulesContent(true, false), CODEX_RULES_CONTENT);
  assert.equal(codexRulesContent(false, false), null);
  const rules = codexRulesContent(true, true) ?? "";
  assert.ok(rules.startsWith(CODEX_RULES_CONTENT));
  assert.equal(rules.match(/^prefix_rule\(/gmu)?.length, 11);
  assert.match(rules, /pattern = \["env", "-u", "CODEX_SANDBOX_NETWORK_DISABLED", "agent-ops", "run"\]/u);
  assert.match(rules, /justification = "agent-ops run [^"]*outside the sandbox\."/u);
  const runRules = codexRulesContent(false, true) ?? "";
  assert.ok(runRules.startsWith(CODEX_RULES_MARKER));
  assert.equal(runRules.match(/^prefix_rule\(/gmu)?.length, 1);
  assert.ok(rules.endsWith(runRules.slice(CODEX_RULES_MARKER.length + 1)));

  const { root, codexHome } = await scratch();
  try {
    const result = await runInitCommand({
      args: parseArgs(["init", "--scope", "project", "--harness", "claude,codex", "--profile", "run", "--yes"]),
      root,
      // run implies loop, whose hooks need an installed runtime path.
      hookRuntimePath: "/opt/agent-ops/hook-entry.js",
      adapters: commonHarnessAdapters(),
      isTTY: false,
      codexHome,
      confirm: async () => true
    });
    assert.equal(result.status, "ok");
    const installed = JSON.parse(await readFile(join(root, CLAUDE_LOCAL_SETTINGS_PATH), "utf8")) as typeof settings;
    assert.deepEqual(installed.permissions.allow, CLAUDE_PREAUTH_RUN_ALLOW);
    assert.deepEqual(installed.sandbox.excludedCommands, CLAUDE_PREAUTH_RUN_UNSANDBOXED);
    const file = join(codexHome, CODEX_RULES_PATH);
    assert.equal(await readFile(file, "utf8"), runRules);

    try {
      await run("codex", ["--version"]);
    } catch {
      t.skip("codex is not installed");
      return;
    }
    const check = async (...command: string[]) => JSON.parse(
      (await run("codex", ["execpolicy", "check", "--rules", file, ...command])).stdout
    ) as { decision?: string };
    const prefix = ["env", "-u", "CODEX_SANDBOX_NETWORK_DISABLED", "agent-ops", "run"];
    assert.equal((await check(...prefix, "--goal-file", ".agent-ops/state/run-goal.md", "--host", "codex", "--wait")).decision, "allow");
    assert.equal((await check(...prefix, "respond", "run-1234abcd", "--question-id", "q", "--answer", "yes")).decision, "allow");
    assert.equal((await check(...prefix)).decision, "allow");
    assert.equal((await check("env", "-u", "CODEX_SANDBOX_NETWORK_DISABLED", "agent-ops", "review", "--task", "t", "--yes")).decision, undefined);
  } finally {
    await rm(join(root, ".."), { recursive: true, force: true });
  }
});
