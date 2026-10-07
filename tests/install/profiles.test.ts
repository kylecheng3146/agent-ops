import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { AgentOpsError } from "../../runtime/src/fs/paths.js";
import {
  PROFILE_CAPABILITIES,
  resolveCapabilities,
  resolveProfiles
} from "../../runtime/src/install/profiles.js";
import type { AgentOpsConfig } from "../../runtime/src/contracts.js";
import {
  COMMON_AGENTS_BLOCK,
  COMMON_CLAUDE_BLOCK,
  harnessDescriptor,
  managedRules
} from "../../runtime/src/install/harness.js";

const LOOP_PROFILE = ["loop"] as never;

const ALL_CAPABILITIES = [
  "rules",
  "task",
  "verify",
  "review",
  "lifecycle-summary",
  "local-log",
  "command-policy"
];

test("defines the exact capabilities for each installation profile", () => {
  assert.deepEqual(PROFILE_CAPABILITIES, {
    core: ["rules", "task", "verify", "review"],
    advisory: ["lifecycle-summary", "local-log"],
    guardrails: ["command-policy"],
    loop: ["project-loop"],
    run: ["auto-run"]
  });
});

test("run implies loop and core and contributes the auto-run capability", () => {
  assert.deepEqual(resolveProfiles(["run"]), {
    profiles: ["core", "loop", "run"],
    capabilities: ["rules", "task", "verify", "review", "project-loop", "auto-run"]
  });
});

test("guardrails implies core while advisory remains independent", () => {
  assert.deepEqual(resolveProfiles(["guardrails"]), {
    profiles: ["core", "guardrails"],
    capabilities: [
      "rules",
      "task",
      "verify",
      "review",
      "command-policy"
    ]
  });
  assert.deepEqual(resolveProfiles(["advisory"]), {
    profiles: ["advisory"],
    capabilities: ["lifecycle-summary", "local-log"]
  });
});

test("loop implies core and contributes the project loop capability", () => {
  assert.deepEqual(resolveProfiles(LOOP_PROFILE), {
    profiles: ["core", "loop"],
    capabilities: ["rules", "task", "verify", "review", "project-loop"]
  });
});

test("resolves optional Stop verification only from the explicit feature", () => {
  const base: AgentOpsConfig = {
    schemaVersion: 3,
    profiles: ["guardrails"],
    verification: { commands: [] },
    features: {
      completionGate: { enabled: false },
      stopVerification: { enabled: false }
    },
    pathMappings: [],
    securityExceptions: []
  };
  assert.deepEqual(resolveCapabilities(base).capabilities, [
    "rules",
    "task",
    "verify",
    "review",
    "command-policy"
  ]);
  assert.deepEqual(
    resolveCapabilities({
      ...base,
      verification: {
        commands: [
          {
            id: "test",
            command: "node",
            args: [],
            cwd: ".",
            required: true,
            evidence: { kind: "exit-code" }
          }
        ]
      },
      features: {
        completionGate: { enabled: false },
        stopVerification: { enabled: true }
      }
    }).capabilities,
    [
      "rules",
      "task",
      "verify",
      "review",
      "command-policy",
      "optional-stop-verify"
    ]
  );
});

test("deduplicates and returns profiles and capabilities in canonical order", () => {
  const resolved = resolveProfiles([
    "guardrails",
    "advisory",
    "core",
    "guardrails",
    "advisory"
  ]);

  assert.deepEqual(resolved, {
    profiles: ["core", "advisory", "guardrails"],
    capabilities: ALL_CAPABILITIES
  });
  assert.equal(
    new Set(resolved.capabilities).size,
    resolved.capabilities.length
  );
});

test("keeps loop last in canonical profile order", () => {
  assert.deepEqual(
    resolveProfiles(["loop", "advisory", "guardrails"] as never),
    {
      profiles: ["core", "advisory", "guardrails", "loop"],
      capabilities: [
        "rules",
        "task",
        "verify",
        "review",
        "lifecycle-summary",
        "local-log",
        "command-policy",
        "project-loop"
      ]
    }
  );
});

test("deduplicates repeated core selections", () => {
  assert.deepEqual(resolveProfiles(["core", "core"]), {
    profiles: ["core"],
    capabilities: ["rules", "task", "verify", "review"]
  });
});

test("fails closed with a stable AgentOpsError when no profile is selected", () => {
  assert.throws(
    () => resolveProfiles([]),
    (error: unknown) =>
      error instanceof AgentOpsError &&
      error.code === "PROFILE_REQUIRED" &&
      error.message === "At least one installation profile is required."
  );
});

test("common routing templates use only managed specification paths", async () => {
  const templates = [
    {
      path: "templates/common/AGENTS.block.md",
      target: ".agent-ops/AGENTS.md"
    },
    {
      path: "templates/common/CLAUDE.block.md",
      target: ".agent-ops/CLAUDE.md"
    }
  ];

  for (const template of templates) {
    const content = (await readFile(resolve(template.path), "utf8"))
      .replace(/\r\n?/gu, "\n");
    const referencedMarkdownPaths = [
      ...content.matchAll(/`([^`]+\.md)`/g)
    ].map((match) => match[1]);

    assert.match(content, /Loop Engineering/);
    if (template.target.endsWith("CLAUDE.md")) {
      // Claude Code only auto-loads via the `@path` import syntax, so the
      // managed path appears bare rather than in a code span.
      assert.deepEqual(referencedMarkdownPaths, []);
      assert.match(content, /^@\.agent-ops\/CLAUDE\.md$/mu);
    } else {
      assert.deepEqual(referencedMarkdownPaths, [template.target]);
    }
    assert.doesNotMatch(content, /<!--\s*agent-ops:/i);
    assert.doesNotMatch(content, /(?:^|\s)\/(?:Users|home)\//);
    assert.equal(
      content,
      template.target.endsWith("AGENTS.md")
        ? COMMON_AGENTS_BLOCK
        : COMMON_CLAUDE_BLOCK
    );
  }
});

test("managed rules authorize the independent review invocation", () => {
  const content = managedRules(harnessDescriptor("codex"), {
    scope: "project",
    profiles: ["core"],
    capabilities: ["rules", "review"]
  });
  assert.match(content, /agent-ops review --task <task-id> --yes/);
  assert.match(content, /trusted outer host runner as its first/);
  assert.match(content, /sandbox_permissions: "require_escalated"/);
  assert.match(content, /unset[\s\S]*CODEX_SANDBOX_NETWORK_DISABLED/);
  assert.match(content, /env -u CODEX_SANDBOX_NETWORK_DISABLED AGENT_OPS_HOST=<current-host>/);
  assert.match(content, /Do not run it once in the restricted sandbox/);
  // No shell redirect: a host can only allow one by matching the whole command string.
  assert.match(content, /--output <file>/);
  assert.match(content, /instead of\s+a shell redirect/);
});

test("managed rules tell each harness how to delegate a subtask", () => {
  const context = {
    scope: "project",
    profiles: ["core"],
    capabilities: ["rules", "task"]
  } as const;
  const claude = managedRules(harnessDescriptor("claude"), context);
  assert.match(claude, /Delegate it with the Task tool\./);
  assert.match(claude, /fingerprint the working tree and report UNKNOWN/);
  assert.match(
    managedRules(harnessDescriptor("agy"), context),
    /Delegate it with `invoke_subagent`/
  );
  assert.equal(
    managedRules(harnessDescriptor("codex"), context),
    managedRules(harnessDescriptor("opencode"), context)
  );
});

test("managed rules tell every harness how to run a batch review", () => {
  for (const id of ["claude", "codex", "agy", "opencode"] as const) {
    const content = managedRules(harnessDescriptor(id), {
      scope: "project",
      profiles: ["core"],
      capabilities: ["rules", "task"]
    }).replace(/\s+/gu, " ");
    assert.match(content, /run `agent-ops batch --parent <task-id> --yes` instead of one review per subtask/u, id);
    assert.match(content, /start it through the trusted outer host runner as its first and only invocation, with the same Codex elevation/u, id);
    assert.match(content, /keep `--output <file>` instead of a shell redirect/u, id);
    assert.match(content, /Do not commit or edit the worktree while it runs: a moved HEAD voids every verify and review in the batch/u, id);
  }
});

test("managed rules route parallel conversations through their own worktree", () => {
  const content = managedRules(harnessDescriptor("claude"), {
    scope: "project",
    profiles: ["core"],
    capabilities: ["rules", "task"]
  }).replace(/\s+/gu, " ");
  assert.match(content, /`worktree\.mode` to `auto`/u);
  assert.match(content, /run `agent-ops task create` from the main checkout before your first edit: it creates this session's worktree and puts the task there/u);
  assert.match(content, /`agent-ops worktree add <name> --session <session-id>` does the same without a task/u);
  assert.match(content, /Claude Code: EnterWorktree with that path/u);
  assert.match(content, /run verify and review for each task with the printed `--base`; do not run `task complete` in the worktree/u);
  assert.match(content, /ExitWorktree with action keep\) and run `agent-ops worktree finish <name>` from the main checkout: it completes every task in the worktree, subtasks first, then merges/u);
  assert.match(content, /reports an incomplete task names it; verify or review that task again/u);
  assert.match(content, /resolved once, as a new task whose criteria cover both intents/u);
});

// Digests of the rules agent-ops 0.6.0 wrote, before the run profile existed.
const RULES_BEFORE_RUN = [
  {
    context: {
      scope: "project",
      profiles: ["core", "advisory", "guardrails", "loop"],
      capabilities: ["rules", "task", "verify", "review", "lifecycle-summary", "local-log", "command-policy", "project-loop", "completion-gate"],
      toolkitVersion: "0.6.0"
    },
    digests: {
      claude: "f701a5b90ca077e7e5333156774549532e1e66b0e1308d5a5b79449ccd8ea580",
      codex: "2f3f4aa0aa04a35134f2b330b06a728f629e36fdbfd57072a5d1f9861308cc54",
      agy: "5c0b33a6166d1e0188a5211494a33c7c46be75a3c1fde635b8518ea535c0d931",
      opencode: "2f3f4aa0aa04a35134f2b330b06a728f629e36fdbfd57072a5d1f9861308cc54"
    }
  },
  {
    context: { scope: "project", profiles: ["core"], capabilities: ["rules", "task"] },
    digests: {
      claude: "7dfd815d0ac08b81d7fe46ee7b29a22a031b3b39b68dcb407d1dc9d4533caa0b",
      codex: "445df4ac14d4139e36c90a488a2f743412c075a1d3366ca06bf3ff9f6be07593",
      agy: "b243dead14cd194faf24bebf30eb39007d9ae49f8f0309d38aa1151725cf5fe3",
      opencode: "445df4ac14d4139e36c90a488a2f743412c075a1d3366ca06bf3ff9f6be07593"
    }
  }
] as const;

test("managed rules without auto-run are byte-identical to before the run profile", () => {
  for (const { context, digests } of RULES_BEFORE_RUN) {
    for (const [id, digest] of Object.entries(digests)) {
      const content = managedRules(harnessDescriptor(id as never), context as never);
      assert.equal(createHash("sha256").update(content).digest("hex"), digest, id);
    }
  }
});

test("auto-run hands more than five criteria to agent-ops run on Claude Code and Codex only", () => {
  const without = { scope: "project", profiles: ["core", "loop"], capabilities: ["rules", "task", "verify", "review", "project-loop"] } as const;
  const withRun = { scope: "project", profiles: ["core", "loop", "run"], capabilities: [...without.capabilities, "auto-run"] } as const;
  const header = (text: string): string => text.replace(/^Active (profiles|capabilities): .*$/gmu, "");
  // agy keeps the subtask flow: only the header lists the profile.
  assert.equal(header(managedRules(harnessDescriptor("agy"), withRun)), header(managedRules(harnessDescriptor("agy"), without)));
  for (const id of ["claude", "codex"] as const) {
    const content = managedRules(harnessDescriptor(id), withRun).replace(/\s+/gu, " ");
    assert.match(content, /a change that needs more than five acceptance criteria goes to `agent-ops run` instead of being split here; five or fewer stay in this session/u, id);
    assert.match(content, /before any `task create` \(its worktree makes `run` refuse with `WORKTREE_NESTED`\)/u, id);
    assert.match(content, /the user's prompt verbatim, then your proposed acceptance criteria marked as proposals, to `\.agent-ops\/state\/run-goal\.md`/u, id);
    assert.ok(content.includes(`agent-ops run --goal-file .agent-ops/state/run-goal.md --host ${id} --wait`), id);
    assert.match(content, /as a background shell command/u, id);
    assert.match(content, /relay the question to the user, run `agent-ops run respond <id> --question-id <q> --answer <text>`/u, id);
    assert.match(content, /`RUN_TARGET_REQUIRED`, `RUN_BACKGROUND_UNSUPPORTED`, `RUN_TARGET_DIRTY` or `WORKTREE_NESTED`, say so in one line naming the code and fall back to the subtask flow/u, id);
    assert.match(content, /`RUN_REPO_UNTRUSTED` means stop and ask the user; never work around trust/u, id);
    assert.match(content, /`agent-ops run status <id>` state and code, the last `agent-ops run logs <id>` events, and the exact `agent-ops run resume <id>` and `agent-ops run stop <id>` commands, then stop: never resume automatically/u, id);
    // The hand-off sits in the task-split paragraph, after the subtask rule it replaces for large changes.
    assert.ok(content.indexOf("completing one never completes its parent.") < content.indexOf("With the `run` profile"), id);
    // Without auto-run, the same harness says nothing about run.
    assert.doesNotMatch(managedRules(harnessDescriptor(id), without), /agent-ops run /u, id);
  }
  const codex = managedRules(harnessDescriptor("codex"), withRun).replace(/\s+/gu, " ");
  assert.match(codex, /`sandbox_permissions: "require_escalated"`/u);
  assert.ok(codex.includes("`env -u CODEX_SANDBOX_NETWORK_DISABLED agent-ops run --goal-file .agent-ops/state/run-goal.md --host codex --wait`"));
  assert.doesNotMatch(managedRules(harnessDescriptor("claude"), withRun), /CODEX_SANDBOX_NETWORK_DISABLED agent-ops run/u);
  assert.equal(managedRules(harnessDescriptor("codex"), withRun), managedRules(harnessDescriptor("opencode"), withRun));
});
