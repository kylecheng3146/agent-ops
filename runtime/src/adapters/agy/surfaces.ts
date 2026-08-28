import type { InstallScope } from "../../contracts.js";
import type { HarnessSurface } from "../../install/types.js";

export function agySurfaces(scope: InstallScope): readonly HarnessSurface[] {
  return [{
    id: "agy-hooks",
    path: scope === "project" ? ".agents/hooks.json" : ".gemini/config/hooks.json",
    scope,
    access: "managed-default",
    representation: "json"
  }];
}
