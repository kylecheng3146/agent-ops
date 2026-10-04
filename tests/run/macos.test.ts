import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  compareBootLogin,
  createLaunchdDescriptor,
  LaunchdController,
  readBootIdentity
} from "../../runtime/src/run/macOS.js";

test("macOS primitive is transient, private, and explicit about reboot resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-launchd-"));
  try {
    const descriptor = createLaunchdDescriptor({
      runId: "run/unsafe-id",
      workerId: "worker one",
      privateDirectory: root,
      command: "/usr/bin/env",
      args: ["node", "worker.js"],
      cwd: root,
      uid: 501
    });
    assert.equal(descriptor.path.startsWith(`${root}/`), true);
    assert.equal(descriptor.xml.includes("RunAtLoad"), true);
    assert.equal(descriptor.xml.includes("KeepAlive"), true);
    assert.equal(descriptor.xml.includes("/Library/LaunchAgents"), false);
    assert.deepEqual(compareBootLogin(
      { boot: "b1", login: "l1" },
      { boot: "b2", login: "l1" }
    ), { resume: false, reason: "boot-change" });
    assert.deepEqual(compareBootLogin(
      { boot: "b1", login: "l1" },
      { boot: "b1", login: "l1" }
    ), { resume: true, reason: "same-login" });

    const calls: string[][] = [];
    const controller = new LaunchdController({
      platform: "darwin",
      uid: 501,
      execFile: async (_file, args) => {
        calls.push([...args]);
        return {};
      }
    });
    await controller.writeDescriptor(descriptor);
    assert.equal((await readFile(descriptor.path, "utf8")).includes("agent-ops"), true);
    await controller.disableRestart(descriptor, "terminal state");
    assert.equal(await controller.isRestartDisabled(descriptor), true);
    assert.equal(calls.some((args) => args[0] === "disable"), true);
    await controller.enableRestart(descriptor);
    assert.equal(await controller.isRestartDisabled(descriptor), false);
    assert.equal(calls.some((args) => args[0] === "enable"), true);
    await controller.bootstrap(descriptor);
    await controller.bootout(descriptor);
    assert.equal(calls.some((args) => args[0] === "bootstrap"), true);
    assert.equal(calls.some((args) => args[0] === "bootout"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("boot identity is injectable for capability evidence", async () => {
  assert.equal(await readBootIdentity("darwin", async () => ({ stdout: "boot-123\n" })), "boot-123");
  assert.equal(await readBootIdentity("linux"), "platform:linux");
});
