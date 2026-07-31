import type { HarnessSurface } from "./types.js";

export function findSurfaceById(
  surfaces: readonly HarnessSurface[],
  id: string
): HarnessSurface | undefined {
  return surfaces.find((surface) => surface.id === id);
}

export function findSurfaceByPath(
  surfaces: readonly HarnessSurface[],
  path: string
): HarnessSurface | undefined {
  return surfaces.find((surface) => surface.path === path);
}

export function isWritableSurface(
  surface: HarnessSurface | undefined
): surface is HarnessSurface {
  return (
    surface !== undefined &&
    (surface.access === "managed-default" ||
      surface.access === "managed-opt-in")
  );
}
