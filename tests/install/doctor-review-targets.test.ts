import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ReviewTargetId } from "../../runtime/src/contracts.js";
import {
  doctorInstallation,
  type DoctorCheck
} from "../../runtime/src/install/doctor.js";
import type { ReviewTargetProbeResult } from "../../runtime/src/review/probe.js";

interface Recorded {
  readonly probed: ReviewTargetId[];
}

async function root(targets: readonly ReviewTargetId[] | undefined): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-ops-doctor-"));
  await mkdir(join(directory, ".agent-ops"), { recursive: true });
  await writeFile(
    join(directory, ".agent-ops", "config.json"),
    `${JSON.stringify(
      {
        schemaVersion: 2,
        profiles: ["core"],
        verification: { commands: [] },
        features: { stopVerification: { enabled: false } },
        pathMappings: [],
        securityExceptions: [],
        ...(targets === undefined
          ? {}
          : {
              reviewRoles: [
                { role: "independent-review", targets: [...targets] }
              ]
            })
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return directory;
}

async function reviewCheck(
  targets: readonly ReviewTargetId[] | undefined,
  options: {
    readonly checkAuth?: boolean;
    readonly results?: Readonly<Partial<Record<ReviewTargetId, ReviewTargetProbeResult>>>;
    readonly recorded?: Recorded;
  } = {}
): Promise<DoctorCheck> {
  const directory = await root(targets);
  try {
    const report = await doctorInstallation({
      root: directory,
      ...(options.checkAuth === undefined
        ? {}
        : { checkReviewTargetAuth: options.checkAuth }),
      probes: {
        reviewTarget: async (target) => {
          options.recorded?.probed.push(target);
          return options.results?.[target] ?? "ok";
        }
      }
    });
    const found = report.checks.find(
      (item) => item.id === "review-targets"
    );
    assert.notEqual(found, undefined, "review-targets check must exist");
    return found as DoctorCheck;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("no configured targets passes and says the feature is disabled", async () => {
  const recorded: Recorded = { probed: [] };
  const check = await reviewCheck(undefined, { recorded });
  assert.equal(check.status, "PASS");
  assert.match(check.message, /External review disabled/);
  assert.match(check.message, /agent-ops init/);
  assert.deepEqual(recorded.probed, []);
});

test("the default depth verifies presence only and never probes auth", async () => {
  const recorded: Recorded = { probed: [] };
  const check = await reviewCheck(["codex", "agy"], { recorded });
  assert.equal(check.status, "PASS");
  assert.match(check.message, /Login state unverified/);
  assert.match(check.message, /agent-ops doctor --check-auth/);
  assert.deepEqual(recorded.probed, ["codex", "agy"]);
});

test("a missing executable fails with install-or-remove guidance", async () => {
  const check = await reviewCheck(["codex", "agy"], {
    results: { codex: "missing-executable" }
  });
  assert.equal(check.status, "FAIL");
  assert.equal(check.code, "UPDATE_REQUIRED");
  assert.match(check.message, /codex not found/);
  assert.match(check.message, /reviewRoles\[\]\.targets/);
});

test("--check-auth turns an unauthenticated target into a FAIL with the login command", async () => {
  const recorded: Recorded = { probed: [] };
  const check = await reviewCheck(["agy"], {
    checkAuth: true,
    results: { agy: "unauthenticated" },
    recorded
  });
  assert.equal(check.status, "FAIL");
  assert.match(check.message, /agy is installed but not authenticated/);
  assert.match(check.message, /agy login/);
  assert.deepEqual(recorded.probed, ["agy"]);
});

test("--check-auth probes each configured target exactly once", async () => {
  const recorded: Recorded = { probed: [] };
  const check = await reviewCheck(["codex", "agy", "claude"], {
    checkAuth: true,
    recorded
  });
  assert.equal(check.status, "PASS");
  assert.deepEqual(recorded.probed, ["codex", "agy", "claude"]);
  assert.doesNotMatch(check.message, /unverified/);
});

test("the check never reports UNKNOWN, so a healthy install keeps its exit code", async () => {
  for (const targets of [undefined, ["codex"] as const]) {
    for (const checkAuth of [false, true]) {
      const check = await reviewCheck(targets, { checkAuth });
      assert.notEqual(check.status, "UNKNOWN");
      assert.notEqual(check.status, "UNSUPPORTED");
    }
  }
});

test("without an injected probe the check still resolves without spawning", async () => {
  const directory = await root(undefined);
  try {
    const report = await doctorInstallation({ root: directory });
    const check = report.checks.find((item) => item.id === "review-targets");
    assert.equal(check?.status, "PASS");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
