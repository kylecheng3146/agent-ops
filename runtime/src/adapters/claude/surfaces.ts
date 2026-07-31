import type { InstallScope } from "../../contracts.js";
import type { HarnessSurface } from "../../install/types.js";

export const CLAUDE_SURFACE_IDS = {
  settings: "claude-settings",
  projectLocal: "project-local",
  userSettings: "user-settings",
  plugin: "plugin"
} as const;

export function claudeSurfaces(
  scope: InstallScope
): readonly HarnessSurface[] {
  if (scope === "project") {
    return [
      {
        id: CLAUDE_SURFACE_IDS.settings,
        path: ".claude/settings.json",
        scope: "project",
        access: "managed-default",
        representation: "json"
      },
      {
        id: CLAUDE_SURFACE_IDS.projectLocal,
        path: ".claude/settings.local.json",
        scope: "project",
        access: "managed-opt-in",
        representation: "json"
      },
      {
        id: CLAUDE_SURFACE_IDS.userSettings,
        path: "~/.claude/settings.json",
        scope: "external",
        access: "inspect-only",
        representation: "json"
      },
      {
        id: CLAUDE_SURFACE_IDS.plugin,
        path: "~/.claude/plugins",
        scope: "external",
        access: "inspect-only",
        representation: "javascript"
      }
    ];
  }
  return [
    {
      id: CLAUDE_SURFACE_IDS.settings,
      path: ".claude/settings.json",
      scope: "user",
      access: "managed-default",
      representation: "json"
    },
    {
      id: CLAUDE_SURFACE_IDS.projectLocal,
      path: "project/.claude/settings.local.json",
      scope: "external",
      access: "inspect-only",
      representation: "json"
    },
    {
      id: CLAUDE_SURFACE_IDS.userSettings,
      path: "project/.claude/settings.json",
      scope: "external",
      access: "inspect-only",
      representation: "json"
    },
    {
      id: CLAUDE_SURFACE_IDS.plugin,
      path: "~/.claude/plugins",
      scope: "external",
      access: "inspect-only",
      representation: "javascript"
    }
  ];
}
