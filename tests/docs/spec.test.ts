import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";

const root = resolve("docs/en/spec");
const modules = [
  "loop-engineering.md",
  "acceptance-and-evidence.md",
  "judgment.md",
  "delegation.md",
  "review.md",
  "troubleshooting.md",
  "guardrails.md",
  "maintenance.md",
  "harness-adapters.md"
];

test("every normative rule has stable metadata and examples", async () => {
  for (const file of modules) {
    const source = await readFile(join(root, file), "utf8");
    const rules = [...source.matchAll(/^## ([-A-Z0-9]+)$/gm)].map((match) => match[1]);
    assert.ok(rules.length > 0, `${file} has no rules`);
    assert.equal(new Set(rules).size, rules.length, `${file} has duplicate rule IDs`);
    for (const id of rules) {
      const start = source.indexOf(`## ${id}`);
      const next = source.indexOf("\n## ", start + 1);
      const block = source.slice(start, next < 0 ? undefined : next);
      assert.match(block, /\b(MUST|MUST NOT|SHOULD|SHOULD NOT)\b/, id);
      for (const label of ["Trigger:", "Action:", "Evidence:", "Positive:", "Negative:"]) {
        assert.match(block, new RegExp(`\\b${label}`), `${id} missing ${label}`);
      }
    }
  }
});

test("spec links resolve and dated facts declare revalidation", async () => {
  for (const file of ["README.md", ...modules]) {
    const source = await readFile(join(root, file), "utf8");
    for (const target of source.matchAll(/\]\(([^)#]+)(?:#[^)]+)?\)/g)) {
      if (target[1]?.startsWith("http")) continue;
      const resolved = resolve(dirname(join(root, file)), target[1] ?? "");
      await access(resolved);
      assert.equal(relative(root, resolved).startsWith(".."), false);
    }
    if (/\b20\d{2}-\d{2}-\d{2}\b/.test(source)) {
      assert.match(source, /Revalidate:/, `${file} dated fact lacks revalidation`);
    }
  }
});
