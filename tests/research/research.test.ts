import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve("research");

test("research scaffolding is protocol-only and has a valid result schema", async () => {
  const readme = await readFile(join(root, "README.md"), "utf8");
  const schema = JSON.parse(
    await readFile(join(root, "schemas/result.schema.json"), "utf8")
  ) as { type?: string; required?: string[] };
  assert.equal(schema.type, "object");
  assert.ok(schema.required?.includes("status"));
  assert.match(readme, /protocol|schema|fixture/i);
  assert.doesNotMatch(readme, /historical result|measured result|internal repository/i);
  await access(join(root, "fixtures/README.md"));
  assert.doesNotMatch(readme, /frontend-wixgo|agent-ops-build|\/private\/tmp/);
  for (const protocol of ["codex-hook-smoke.md", "claude-hook-smoke.md"]) {
    const source = await readFile(join(root, "protocols", protocol), "utf8");
    const result = source.match(/^Result: `([^`]+)`$/m)?.[1];
    assert.ok(result, `${protocol} must link a result file`);
    await access(join(root, "protocols", result));
    assert.doesNotMatch(source, /frontend-wixgo|agent-ops-build|\/private\/tmp/);
  }
});
