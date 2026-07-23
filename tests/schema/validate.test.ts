import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  validateConfig,
  validateEvidence,
  validateManifest,
  validateTask
} from "../../runtime/src/schema/validate.js";

async function readJsonFixture(name: string): Promise<unknown> {
  const path = resolve("tests", "fixtures", "schema", name);
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function firstErrorCode(result: { errors: { code: string }[] }): string {
  return result.errors[0]?.code ?? "";
}

test("accepts fully valid version 1 fixtures", async () => {
  const [config, taskFixture, evidence, manifest] = await Promise.all([
    readJsonFixture("valid-config.json"),
    readJsonFixture("valid-task.json"),
    readJsonFixture("valid-evidence.json"),
    readJsonFixture("valid-manifest.json")
  ]);

  assert.equal(validateConfig(config).ok, true);
  assert.equal(validateTask(taskFixture).ok, true);
  assert.equal(validateEvidence(evidence).ok, true);
  assert.equal(validateManifest(manifest).ok, true);
});

test("rejects shell execution without explicit acknowledgement", async () => {
  const result = validateConfig(
    await readJsonFixture("invalid-shell-ack.json")
  );

  assert.equal(result.ok, false);
  assert.match(firstErrorCode(result), /SHELL_ACK_REQUIRED/);
});

test("returns stable codes for invalid config fixtures", async () => {
  const cases = [
    ["invalid-wrong-version.json", "SCHEMA_VERSION_UNSUPPORTED"],
    ["invalid-duplicate-id.json", "DUPLICATE_ID"],
    ["invalid-unknown-reference.json", "UNKNOWN_VERIFIER_REFERENCE"],
    ["invalid-path.json", "INVALID_RELATIVE_PATH"],
    ["invalid-profile.json", "INVALID_PROFILE"],
    ["invalid-exception-scope.json", "UNSAFE_EXCEPTION_SCOPE"]
  ] as const;

  for (const [fixture, expectedCode] of cases) {
    const result = validateConfig(await readJsonFixture(fixture));
    assert.equal(result.ok, false, fixture);
    assert.equal(firstErrorCode(result), expectedCode, fixture);
  }
});

test("rejects portable-path violations before command execution is possible", async () => {
  const valid = (await readJsonFixture("valid-config.json")) as {
    verification: { commands: { cwd: string }[] };
  };

  for (const invalidPath of [
    "/tmp/project",
    "../outside",
    "C:/project",
    "C:\\project",
    "src\\feature"
  ]) {
    const value = cloneJson(valid);
    value.verification.commands[0]!.cwd = invalidPath;
    const result = validateConfig(value);
    assert.equal(result.ok, false, invalidPath);
    assert.equal(firstErrorCode(result), "INVALID_RELATIVE_PATH", invalidPath);
  }
});

test("requires two to five unique task criteria", async () => {
  const valid = (await readJsonFixture("valid-task.json")) as {
    criteria: {
      id: string;
      description: string;
      verifierIds: string[];
    }[];
  };

  const tooFew = cloneJson(valid);
  tooFew.criteria = tooFew.criteria.slice(0, 1);
  assert.equal(
    firstErrorCode(validateTask(tooFew)),
    "CRITERIA_COUNT_INVALID"
  );

  const tooMany = cloneJson(valid);
  tooMany.criteria = Array.from({ length: 6 }, (_, index) => ({
    id: `criterion-${index}`,
    description: `Criterion ${index}`,
    verifierIds: ["test"]
  }));
  assert.equal(
    firstErrorCode(validateTask(tooMany)),
    "CRITERIA_COUNT_INVALID"
  );

  const duplicate = cloneJson(valid);
  duplicate.criteria[1]!.id = duplicate.criteria[0]!.id;
  assert.equal(firstErrorCode(validateTask(duplicate)), "DUPLICATE_ID");
});

test("rejects raw prompts and output in persistent evidence", async () => {
  const valid = (await readJsonFixture("valid-evidence.json")) as Record<
    string,
    unknown
  >;

  for (const forbiddenField of ["prompt", "rawOutput"]) {
    const value = cloneJson(valid);
    value[forbiddenField] = "must not persist";
    const result = validateEvidence(value);
    assert.equal(result.ok, false, forbiddenField);
    assert.equal(firstErrorCode(result), "UNKNOWN_FIELD", forbiddenField);
  }
});

test("rejects invalid manifest hashes, paths, and duplicate ownership", async () => {
  const valid = (await readJsonFixture("valid-manifest.json")) as {
    artifacts: { path: string; hash: string; owner: string }[];
    markers: { path: string; hash: string; owner: string }[];
  };

  const invalidPath = cloneJson(valid);
  invalidPath.artifacts[0]!.path = "../outside";
  assert.equal(
    firstErrorCode(validateManifest(invalidPath)),
    "INVALID_RELATIVE_PATH"
  );

  const invalidHash = cloneJson(valid);
  invalidHash.artifacts[0]!.hash = "not-a-sha256";
  assert.equal(firstErrorCode(validateManifest(invalidHash)), "INVALID_HASH");

  const duplicate = cloneJson(valid);
  duplicate.markers[0]!.path = duplicate.artifacts[0]!.path;
  assert.equal(
    firstErrorCode(validateManifest(duplicate)),
    "DUPLICATE_OWNERSHIP"
  );
});

test("JSON Schema documents expose the same top-level versioned fields", async () => {
  const cases = [
    ["config.schema.json", "valid-config.json"],
    ["task.schema.json", "valid-task.json"],
    ["evidence.schema.json", "valid-evidence.json"],
    ["manifest.schema.json", "valid-manifest.json"]
  ] as const;

  for (const [schemaName, fixtureName] of cases) {
    const schema = JSON.parse(
      await readFile(resolve("schemas", schemaName), "utf8")
    ) as {
      additionalProperties?: boolean;
      properties?: Record<string, { const?: unknown }>;
      required?: string[];
    };
    const fixture = (await readJsonFixture(fixtureName)) as Record<
      string,
      unknown
    >;

    assert.equal(schema.additionalProperties, false, schemaName);
    assert.equal(schema.properties?.schemaVersion?.const, 1, schemaName);
    assert.deepEqual(
      [...(schema.required ?? [])].sort(),
      Object.keys(fixture).sort(),
      schemaName
    );
  }
});
