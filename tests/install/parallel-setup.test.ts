import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  checkWorktreeEnvWarning,
  detectWorktreeSetup
} from "../../runtime/src/install/parallel-setup.js";

test("detectWorktreeSetup detects npm lockfile", async () => {
  const root = await mkdtemp(join(tmpdir(), "wt-detect-npm-"));
  try {
    await writeFile(join(root, "package-lock.json"), "{}");
    const setup = await detectWorktreeSetup(root);
    assert.deepEqual(setup, [{ command: "npm", args: ["ci"] }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detectWorktreeSetup detects pnpm lockfile", async () => {
  const root = await mkdtemp(join(tmpdir(), "wt-detect-pnpm-"));
  try {
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'");
    const setup = await detectWorktreeSetup(root);
    assert.deepEqual(setup, [{ command: "pnpm", args: ["install", "--frozen-lockfile"] }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detectWorktreeSetup detects yarn lockfile", async () => {
  const root = await mkdtemp(join(tmpdir(), "wt-detect-yarn-"));
  try {
    await writeFile(join(root, "yarn.lock"), "# yarn lockfile");
    const setup = await detectWorktreeSetup(root);
    assert.deepEqual(setup, [{ command: "yarn", args: ["install", "--immutable"] }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detectWorktreeSetup detects bun lockfile", async () => {
  const root = await mkdtemp(join(tmpdir(), "wt-detect-bun-"));
  try {
    await writeFile(join(root, "bun.lockb"), "dummy binary lock");
    const setup = await detectWorktreeSetup(root);
    assert.deepEqual(setup, [{ command: "bun", args: ["install", "--frozen-lockfile"] }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detectWorktreeSetup returns empty array when multiple package managers are detected", async () => {
  const root = await mkdtemp(join(tmpdir(), "wt-detect-multi-"));
  try {
    await writeFile(join(root, "package-lock.json"), "{}");
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'");
    const setup = await detectWorktreeSetup(root);
    assert.deepEqual(setup, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detectWorktreeSetup returns empty array when no lockfile is found", async () => {
  const root = await mkdtemp(join(tmpdir(), "wt-detect-none-"));
  try {
    const setup = await detectWorktreeSetup(root);
    assert.deepEqual(setup, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checkWorktreeEnvWarning warns when .env exists and .worktreeinclude is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "wt-env-warn-"));
  try {
    await writeFile(join(root, ".env"), "KEY=VAL");
    const warning = await checkWorktreeEnvWarning(root);
    assert.match(warning ?? "", /Local environment files \(\.env\) detected without \.worktreeinclude/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checkWorktreeEnvWarning does not warn when .worktreeinclude is present", async () => {
  const root = await mkdtemp(join(tmpdir(), "wt-env-ok-"));
  try {
    await writeFile(join(root, ".env"), "KEY=VAL");
    await writeFile(join(root, ".worktreeinclude"), ".env\n");
    const warning = await checkWorktreeEnvWarning(root);
    assert.equal(warning, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
