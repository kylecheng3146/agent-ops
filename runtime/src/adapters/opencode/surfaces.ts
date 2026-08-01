import type { InstallScope } from "../../contracts.js";
import type { HarnessSurface } from "../../install/types.js";
import { opencodePluginTarget } from "./config.js";

export const OPENCODE_SURFACE_IDS = {
  plugin: "opencode-plugin",
  config: "opencode-config"
} as const;

export function opencodeSurfaces(
  scope: InstallScope,
  root?: string
): readonly HarnessSurface[] {
  return [
    {
      id: OPENCODE_SURFACE_IDS.plugin,
      path: opencodePluginTarget(scope, root).path,
      scope,
      access: "managed-default",
      representation: "javascript"
    },
    {
      id: OPENCODE_SURFACE_IDS.config,
      path: "opencode.json",
      scope,
      access: "inspect-only",
      representation: "json"
    }
  ];
}
