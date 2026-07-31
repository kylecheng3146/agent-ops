import type { InstallScope } from "../../contracts.js";
import type { HarnessSurface } from "../../install/types.js";

export const CODEX_SURFACE_ID = "codex-hooks";

export function codexSurfaces(
  scope: InstallScope
): readonly HarnessSurface[] {
  return [
    {
      id: CODEX_SURFACE_ID,
      path: ".codex/hooks.json",
      scope,
      access: "managed-default",
      representation: "json"
    }
  ];
}
