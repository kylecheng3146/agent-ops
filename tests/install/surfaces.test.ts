import assert from "node:assert/strict";
import test from "node:test";

import { claudeSurfaces } from "../../runtime/src/adapters/claude/surfaces.js";
import { codexSurfaces } from "../../runtime/src/adapters/codex/surfaces.js";
import { opencodeSurfaces } from "../../runtime/src/adapters/opencode/surfaces.js";
import {
  harnessDescriptor,
  harnessSurfaces,
  selectHarnessHookSurface
} from "../../runtime/src/install/harness.js";

test("Claude exposes safe shared, local, user, and plugin surfaces", () => {
  const project = claudeSurfaces("project");
  assert.deepEqual(
    project.map(({ id, path, scope, access }) => ({ id, path, scope, access })),
    [
      {
        id: "claude-settings",
        path: ".claude/settings.json",
        scope: "project",
        access: "managed-default"
      },
      {
        id: "project-local",
        path: ".claude/settings.local.json",
        scope: "project",
        access: "managed-opt-in"
      },
      {
        id: "user-settings",
        path: "~/.claude/settings.json",
        scope: "external",
        access: "inspect-only"
      },
      {
        id: "plugin",
        path: "~/.claude/plugins",
        scope: "external",
        access: "inspect-only"
      }
    ]
  );
  assert.equal(
    new Set(project.map(({ id }) => id)).size,
    project.length
  );
  assert.equal(
    new Set(project.map(({ path }) => path)).size,
    project.length
  );

  const userSettings = claudeSurfaces("user").find(
    ({ id }) => id === "claude-settings"
  );
  assert.deepEqual(userSettings, {
    id: "claude-settings",
    path: ".claude/settings.json",
    scope: "user",
    access: "managed-default",
    representation: "json"
  });
});

test("all descriptors expose scope-aware surface metadata", () => {
  for (const id of ["codex", "claude", "opencode"] as const) {
    const descriptor = harnessDescriptor(id);
    for (const scope of ["project", "user"] as const) {
      const surfaces = harnessSurfaces(id, scope, "/tmp/agent-ops-surfaces");
      assert.ok(surfaces.length > 0, `${id}/${scope}`);
      assert.equal(
        new Set(surfaces.map(({ id: surfaceId }) => surfaceId)).size,
        surfaces.length,
        `${id}/${scope} surface IDs`
      );
      assert.equal(descriptor.control.surfaces(scope).length, surfaces.length);
    }
  }
  assert.equal(codexSurfaces("project")[0]?.access, "managed-default");
  assert.equal(opencodeSurfaces("project")[0]?.representation, "javascript");
});

test("hook target selection accepts only writable JSON surfaces", () => {
  assert.equal(
    selectHarnessHookSurface({
      harness: "claude",
      scope: "project",
      surfaceId: "project-local"
    }).path,
    ".claude/settings.local.json"
  );
  assert.equal(
    selectHarnessHookSurface({
      harness: "claude",
      scope: "project",
      persistedPath: ".claude/settings.local.json"
    }).id,
    "project-local"
  );
  assert.throws(
    () =>
      selectHarnessHookSurface({
        harness: "claude",
        scope: "project",
        surfaceId: "plugin"
      }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "HOOK_TARGET_INVALID"
  );
  assert.throws(
    () =>
      selectHarnessHookSurface({
        harness: "opencode",
        scope: "project",
        surfaceId: "opencode-plugin"
      }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "HOOK_TARGET_UNSUPPORTED"
  );
});
