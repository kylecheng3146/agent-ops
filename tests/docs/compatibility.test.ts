import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(path, "utf8");
const sections = (source: string) => [...source.matchAll(/^## /gm)].length;
const identifiers = (source: string) => [...new Set([...source.matchAll(/`([^`]+)`/g)].map((match) => match[1]))].sort();

test("compatibility guide states the 1.0 policy in both languages and is linked", async () => {
  const en = await read("docs/en/guides/compatibility.md");
  const zh = await read("docs/zh-TW/guides/compatibility.md");
  for (const heading of ["Guaranteed interfaces", "Not guaranteed", "Gate changes", "Deprecation", "Upgrades and migration",
    "Supported releases", "Platforms and hosts"]) assert.match(en, new RegExp(`^## ${heading}$`, "m"), heading);
  for (const rule of [/`--json`/, /`REVIEW_NOT_RUN`, `BATCH_NOT_RUN`/, /`\.agent-ops\/config\.json`, the `--surface-file`/,
    /`\.agent-ops-escapes\/`/, /`refs\/notes\/agent-ops`/, /newer 1\.x release reads, or migrates/, /Preview features/,
    /internal formats of local state/, /stricter or looser ships in a minor\s+release/, /may ship in a patch release/,
    /renaming a\s+documented error code is a breaking change/, /at least one minor release,\s+prints a warning on stderr/,
    /removed only in the next major release/, /Downgrading is not supported/, /Only the latest 1\.x minor release receives fixes/,
    /reached end of life is a minor\s+release/, /`RUN_BACKGROUND_UNSUPPORTED`/])
    assert.match(en, rule);
  assert.equal(sections(zh), sections(en));
  assert.deepEqual(identifiers(zh), identifiers(en));
  const readme = await read("README.md");
  assert.match(readme, /## Project status[\s\S]*\]\(docs\/en\/guides\/compatibility\.md\)/);
  assert.match(readme, /## Project status[\s\S]*Release candidates[\s\S]*`next` dist-tag[\s\S]*`@latest` stays on the newest\s+final release/);
  assert.match(await read("SECURITY.md"), /## Supported versions[\s\S]*\]\(docs\/en\/guides\/compatibility\.md\)[\s\S]*## Reporting/);
});

test("surface discovery gate changes are documented in both spec languages and the changelog", async () => {
  for (const [path, cap, untracked] of [
    ["docs/en/spec/acceptance-and-evidence.md", /capped at 400 queries; the dropped count per source is\s+reported/, /untracked regular file/],
    ["docs/zh-TW/spec/acceptance-and-evidence.md", /上限 400 個；各來源被捨棄的數量一定會回報/, /未追蹤的一般檔案/]
  ] as const) {
    const source = await read(path);
    assert.match(source, /`SURFACE_DISCOVERY_FAILED`/, path);
    assert.match(source, cap, path);
    assert.match(source, untracked, path);
  }
  // The entries sit under Unreleased until they ship, then under their version heading.
  const changelog = await read("CHANGELOG.md");
  for (const entry of [/- Gate: surface discovery now fails closed[\s\S]*`SURFACE_DISCOVERY_FAILED`/, /- Gate: derived discovery queries over the 400-per-kind cap/,
    /- Gate: without `--base`, untracked text files/]) assert.match(changelog, entry);
});
