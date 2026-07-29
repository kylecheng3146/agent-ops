#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const source = process.argv[2];
if (source === undefined) {
  console.error("Usage: node scripts/scan-release.mjs <pack-json>");
  process.exitCode = 2;
} else {
  const parsed = JSON.parse(await readFile(source, "utf8"));
  const files = Array.isArray(parsed) ? parsed[0]?.files : parsed.files;
  if (!Array.isArray(files)) {
    throw new Error("Pack metadata does not contain a files array.");
  }
  const allowed = [
    /^package\/package\.json$/u,
    /^package\/dist\//u,
    /^package\/schemas\//u,
    /^package\/templates\//u,
    /^package\/docs\/(en|zh-TW)\/spec\//u,
    /^package\/(README\.md|LICENSE|SECURITY\.md|postinstall\.cjs)$/u
  ];
  const banned = [
    /node_modules/u,
    /(?:^|\/)\.env(?:$|\.)/u,
    /(?:private|tmp|worktree)/iu,
    /\.pem$/iu,
    /\.key$/iu
  ];
  const names = files.map((file) =>
    typeof file === "string" ? file : `package/${String(file.path ?? "")}`
  );
  const unexpected = names.filter(
    (name) => !allowed.some((pattern) => pattern.test(name))
  );
  const forbidden = names.filter((name) => banned.some((pattern) => pattern.test(name)));
  const result = { files: names.sort(), unexpected, forbidden };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (unexpected.length > 0 || forbidden.length > 0) {
    process.exitCode = 1;
  }
}
