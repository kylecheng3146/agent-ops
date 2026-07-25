import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function read(path: string): Promise<string> {
  return await readFile(path, "utf8");
}

test("CI policy covers the cross-platform Node matrix and installed CLI smoke", async () => {
  const workflow = await read(".github/workflows/ci.yml");
  for (const operatingSystem of [
    "ubuntu-latest",
    "macos-latest",
    "windows-latest"
  ]) {
    assert.match(workflow, new RegExp(operatingSystem));
  }
  for (const nodeVersion of ["22.14.0", "22", "24", "26"]) {
    assert.match(workflow, new RegExp(`['\"]${nodeVersion}['\"]`));
  }
  for (const command of [
    "npm ci",
    "npm run typecheck",
    "npm test",
    "npm run build",
    "npm run package:check",
    "node scripts/ci-package-smoke.mjs"
  ]) {
    assert.match(workflow, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(workflow, /matrix\.os/);
  assert.match(workflow, /matrix\.node/);
  assert.doesNotMatch(workflow, /npm\s+publish\b/u);
  assert.doesNotMatch(workflow, /id-token:\s*write/u);
});

test("release policy is dispatch-only, protected, and provenance-capable", async () => {
  const workflow = await read(".github/workflows/release.yml");
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /environment:\s*release/u);
  assert.match(workflow, /id-token:\s*write/u);
  assert.match(workflow, /node-version:\s*["']?24["']?/u);
  assert.match(workflow, /npm\s+publish\b/u);
  assert.match(workflow, /11\.5\.1/u);
  assert.match(workflow, /github\.event_name\s*==\s*["']workflow_dispatch["']/u);
  assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN/u);
  assert.doesNotMatch(workflow, /pull_request:/u);
  assert.doesNotMatch(workflow, /on:\s*push:/u);
  for (const command of [
    "npm ci",
    "npm run typecheck",
    "npm test",
    "npm run build",
    "npm run package:check"
  ]) {
    assert.match(workflow, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(workflow, /version.*tag|tag.*version/isu);
});

test("governance files document safe reporting and review evidence", async () => {
  const security = await read(".github/ISSUE_TEMPLATE/security.yml");
  assert.match(security, /SECURITY\.md/u);
  assert.match(security, /public|do not|不要|公開/iu);
  const pullRequest = await read(".github/pull_request_template.md");
  for (const phrase of [
    "Commands run",
    "Results",
    "Breaking changes",
    "Performance",
    "Telemetry",
    "Migration"
  ]) {
    assert.match(pullRequest, new RegExp(phrase, "iu"));
  }
  const changelog = await read("CHANGELOG.md");
  assert.match(changelog, /Unreleased/u);
});
