import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);

async function testSources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await testSources(path)));
    } else if (entry.name.endsWith(".test.ts")) {
      files.push(path);
    }
  }
  return files;
}

/**
 * A test that reads a repository file only the author's machine has passes
 * here and fails in a fresh clone — and, worse, in the read-only snapshot a
 * review runs against, where it reads as a defect in the change under review.
 */
test("every repository file a test reads is committed", async () => {
  const sources = await testSources(resolve("tests"));
  assert.ok(sources.length > 0, "no test sources were scanned");
  const referenced = new Set<string>();
  for (const source of sources) {
    const text = await readFile(source, "utf8");
    for (const match of text.matchAll(/["'`](docs\/[^"'`\s]+|research\/[^"'`\s]+)["'`]/g)) {
      const path = match[1];
      // Directories are covered by whatever file inside them is read.
      if (path !== undefined && /\.[a-z]+$/u.test(path)) {
        referenced.add(path);
      }
    }
  }
  for (const path of referenced) {
    // Only paths that exist here can be read here. A path that exists on this
    // machine but not in Git is the exact failure this guards: green locally,
    // broken in a clone and in a review snapshot. A synthetic path in a
    // fixture exists nowhere and is not a dependency.
    const present = await access(resolve(path)).then(() => true, () => false);
    if (present) {
      await run("git", ["ls-files", "--error-unmatch", path]);
    }
  }
});
