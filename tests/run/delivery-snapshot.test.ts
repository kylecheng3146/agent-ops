import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtemp, writeFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {assertRunDeliverySnapshot} from "../../packages/cli/src/run-entry.js";
import {FileTaskStore} from "../../runtime/src/task/store.js";
import {TaskService} from "../../runtime/src/task/service.js";

test("handoff rejects a late commit, dirty source or changed task contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-delivery-snapshot-"));
  const git = (...args: string[]) => execFileSync("git", args, {cwd: root, stdio: ["ignore", "pipe", "pipe"]}).toString().trim();
  try {
    git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
    await writeFile(join(root, ".gitignore"), ".agent-ops/\n");
    await writeFile(join(root, "product.txt"), "original\n");
    git("add", "."); git("commit", "-qm", "original");
    const head = git("rev-parse", "HEAD");
    const store = new FileTaskStore(join(root, ".agent-ops/tasks/state.json"), root);
    const tasks = new TaskService(store);
    const record = await tasks.create({title: "Deliver", goal: "Preserve the fixed goal", criteria: [
      {id: "first", description: "First assertion", verifierIds: ["test"]},
      {id: "second", description: "Second assertion", verifierIds: ["test"]}
    ]});
    const contract = await tasks.treeContract(record.task.id);
    await assertRunDeliverySnapshot(root, record.task.id, head, contract, tasks);
    await writeFile(join(root, "product.txt"), "late writer\n");
    await assert.rejects(assertRunDeliverySnapshot(root, record.task.id, head, contract, tasks), {code: "RUN_DELIVERY_CHANGED"});
    git("add", "."); git("commit", "-qm", "late commit before death");
    await assert.rejects(assertRunDeliverySnapshot(root, record.task.id, head, contract, tasks), {code: "RUN_DELIVERY_CHANGED"});
    const latest = git("rev-parse", "HEAD");
    await store.mutate(state => {state.tasks[0]!.task.criteria[0]!.description = "Changed contract";});
    await assert.rejects(assertRunDeliverySnapshot(root, record.task.id, latest, contract, tasks), {code: "RUN_DELIVERY_CHANGED"});
  } finally {await rm(root, {recursive: true, force: true});}
});
