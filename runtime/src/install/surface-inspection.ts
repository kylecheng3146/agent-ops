import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

import type { HarnessId, InstallScope, Profile } from "../contracts.js";
import { resolveContainedPath } from "../fs/paths.js";
import {
  harnessDescriptor,
  harnessSurfaces
} from "./harness.js";
import { resolveProfiles } from "./profiles.js";
import type { Capability, HarnessSurface } from "./types.js";

const MAX_SURFACE_FILE_BYTES = 1024 * 1024;

export interface HarnessSurfaceStatus {
  readonly harness: HarnessId;
  readonly surfaceId: string;
  readonly path: string;
  readonly status: "managed" | "foreign" | "missing" | "unknown";
  readonly managedHandlerCount: number;
  readonly foreignHandlerCount: number;
}

export interface SurfaceInspectionOptions {
  readonly root: string;
  readonly scope: InstallScope;
  readonly harness: readonly HarnessId[];
  readonly profiles: readonly Profile[];
}

interface SurfaceRead {
  readonly source: string;
}

interface HandlerCounts {
  readonly managed: number;
  readonly foreign: number;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readSurface(
  root: string,
  surface: HarnessSurface
): Promise<SurfaceRead | null> {
  if (surface.scope === "external") {
    return null;
  }
  let resolvedPath: string;
  try {
    resolvedPath = await resolveContainedPath(root, surface.path);
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(resolvedPath, { bigint: true });
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
  if (
    !before.isFile() ||
    before.size > BigInt(MAX_SURFACE_FILE_BYTES)
  ) {
    throw new Error("Surface is not a bounded regular file.");
  }
  const handle = await open(
    resolvedPath,
    constants.O_RDONLY |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK
  );
  try {
    const opened = await handle.stat({ bigint: true });
    const resolvedAgain = await resolveContainedPath(root, surface.path);
    const after = await lstat(resolvedAgain, { bigint: true });
    if (
      !opened.isFile() ||
      opened.size > BigInt(MAX_SURFACE_FILE_BYTES) ||
      before.dev !== after.dev ||
      before.ino !== after.ino
    ) {
      throw new Error("Surface identity changed during inspection.");
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= MAX_SURFACE_FILE_BYTES) {
      const remaining = MAX_SURFACE_FILE_BYTES + 1 - totalBytes;
      const chunk = Buffer.alloc(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(
        chunk,
        0,
        chunk.length,
        null
      );
      if (bytesRead === 0) {
        return {
          source: Buffer.concat(chunks, totalBytes).toString("utf8")
        };
      }
      chunks.push(chunk.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    throw new Error("Surface exceeded its inspection limit.");
  } finally {
    await handle.close();
  }
}

function jsonHandlerCounts(
  source: string,
  isManagedHandler: ((handler: unknown) => boolean) | undefined
): HandlerCounts | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const hooks = parsed.hooks;
  if (hooks === undefined) {
    return { managed: 0, foreign: 0 };
  }
  if (!isRecord(hooks)) {
    return null;
  }
  let managed = 0;
  let foreign = 0;
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) {
      return null;
    }
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) {
        return null;
      }
      for (const handler of group.hooks) {
        if (isManagedHandler?.(handler) === true) {
          managed += 1;
        } else {
          foreign += 1;
        }
      }
    }
  }
  return { managed, foreign };
}

function handlerCounts(
  surface: HarnessSurface,
  source: string,
  capabilities: readonly Capability[],
  isManagedHandler: ((handler: unknown) => boolean) | undefined,
  hookRegistered: (
    source: unknown,
    capabilities: readonly Capability[]
  ) => boolean
): HandlerCounts | null {
  if (surface.representation === "json") {
    return jsonHandlerCounts(source, isManagedHandler);
  }
  if (surface.representation === "javascript") {
    return {
      managed: hookRegistered(source, capabilities) ? 1 : 0,
      foreign: 0
    };
  }
  return { managed: 0, foreign: 0 };
}

export async function inspectHarnessSurfaces(
  options: SurfaceInspectionOptions
): Promise<readonly HarnessSurfaceStatus[]> {
  const capabilities =
    options.profiles.length === 0
      ? []
      : resolveProfiles(options.profiles).capabilities;
  const statuses: HarnessSurfaceStatus[] = [];
  for (const harness of options.harness) {
    const descriptor = harnessDescriptor(harness);
    for (const surface of harnessSurfaces(
      harness,
      options.scope,
      options.root
    )) {
      if (surface.scope === "external") {
        statuses.push({
          harness,
          surfaceId: surface.id,
          path: surface.path,
          status: "unknown",
          managedHandlerCount: 0,
          foreignHandlerCount: 0
        });
        continue;
      }
      try {
        const read = await readSurface(options.root, surface);
        if (read === null) {
          statuses.push({
            harness,
            surfaceId: surface.id,
            path: surface.path,
            status: "missing",
            managedHandlerCount: 0,
            foreignHandlerCount: 0
          });
          continue;
        }
        const counts = handlerCounts(
          surface,
          read.source,
          capabilities,
          descriptor.control.isManagedHandler,
          descriptor.control.hookRegistered
        );
        if (counts === null) {
          statuses.push({
            harness,
            surfaceId: surface.id,
            path: surface.path,
            status: "unknown",
            managedHandlerCount: 0,
            foreignHandlerCount: 0
          });
          continue;
        }
        statuses.push({
          harness,
          surfaceId: surface.id,
          path: surface.path,
          status: counts.managed > 0 ? "managed" : "foreign",
          managedHandlerCount: counts.managed,
          foreignHandlerCount: counts.foreign
        });
      } catch {
        statuses.push({
          harness,
          surfaceId: surface.id,
          path: surface.path,
          status: "unknown",
          managedHandlerCount: 0,
          foreignHandlerCount: 0
        });
      }
    }
  }
  return statuses;
}
