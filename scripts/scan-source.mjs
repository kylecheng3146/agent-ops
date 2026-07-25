#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .map((file) => file.trim())
  .filter((file) => file.length > 0);
const patterns = [
  /(?:^|[\s"'`(=])\/(?:Users|home|private|tmp|var|opt|workspace)\//iu,
  /(?:frontend-wixgo|agent-ops-build|(?:^|[./])wixtar\.com)\b/iu,
  /gh[pousr]_[A-Za-z0-9]{20,}/u,
  /github_pat_[A-Za-z0-9_]{20,}/u,
  /sk-[A-Za-z0-9_-]{20,}/u
];
const findings = [];
for (const file of files) {
  if (
    !/^(?:packages|runtime|docs|\.github)\//u.test(file) &&
    !/^(?:README|SECURITY|CONTRIBUTING|CHANGELOG)\.md$/u.test(file)
  ) {
    continue;
  }
  let content;
  try {
    content = await readFile(file, "utf8");
  } catch {
    continue;
  }
  if (patterns.some((pattern) => pattern.test(content))) {
    findings.push(file);
  }
}
if (findings.length > 0) {
  throw new Error(`Source scan found forbidden content in: ${findings.join(", ")}`);
}
process.stdout.write(`source scan passed (${files.length} tracked files)\n`);
