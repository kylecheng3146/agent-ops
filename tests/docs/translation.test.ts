import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const englishSpec = resolve("docs/en/spec");
const chineseSpec = resolve("docs/zh-TW/spec");
const englishGuides = resolve("docs/en/guides");
const chineseGuides = resolve("docs/zh-TW/guides");

async function files(root: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  return (await readdir(root)).filter((file) => file.endsWith(".md")).sort();
}

function ruleIds(source: string): string[] {
  return [...source.matchAll(/^## ([-A-Z0-9]+)$/gm)].map((match) => match[1] ?? "");
}

test("Traditional Chinese spec mirrors every English rule and records source version", async () => {
  const english = await files(englishSpec);
  const chinese = await files(chineseSpec);
  assert.deepEqual(chinese, english);
  for (const file of english.filter((item) => item !== "README.md")) {
    const en = await readFile(join(englishSpec, file), "utf8");
    const zh = await readFile(join(chineseSpec, file), "utf8");
    assert.deepEqual(ruleIds(zh), ruleIds(en), file);
    assert.match(zh, /English source version:/, file);
  }
});

test("guides are paired and relative links resolve", async () => {
  const english = await files(englishGuides);
  assert.deepEqual(await files(chineseGuides), english);
  for (const file of english) {
    const source = await readFile(join(englishGuides, file), "utf8");
    for (const target of source.matchAll(/\]\(([^)#]+)(?:#[^)]+)?\)/g)) {
      if (target[1]?.startsWith("http")) continue;
      await access(resolve(dirname(join(englishGuides, file)), target[1] ?? ""));
    }
  }
});
