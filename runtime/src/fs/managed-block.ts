import { AgentOpsError } from "./paths.js";

export interface ManagedBlockOptions {
  id: string;
  version: number;
  content: string;
}

export interface ManagedBlockMarkers {
  start: string;
  end: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertBlockId(id: string): void {
  if (!/^[a-z][a-z0-9-]{0,127}$/.test(id)) {
    throw new AgentOpsError("INVALID_BLOCK_ID", `Invalid block ID: ${id}`);
  }
}

function assertExactMarkerSyntax(source: string): void {
  const validMarker =
    /^<!-- agent-ops:(?:start [a-z][a-z0-9-]{0,127} v[1-9][0-9]*|end [a-z][a-z0-9-]{0,127}) -->$/;
  for (const line of source.split(/\r?\n/)) {
    if (/<!--\s*agent-ops:/.test(line) && !validMarker.test(line)) {
      throw new AgentOpsError(
        "MALFORMED_MANAGED_BLOCK",
        "Managed block markers must use the exact agent-ops marker syntax."
      );
    }
  }
}

export function managedBlockMarkers(
  id: string,
  version: number
): ManagedBlockMarkers {
  assertBlockId(id);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new AgentOpsError(
      "INVALID_BLOCK_VERSION",
      `Invalid block version: ${version}`
    );
  }
  return {
    start: `<!-- agent-ops:start ${id} v${version} -->`,
    end: `<!-- agent-ops:end ${id} -->`
  };
}

function locateMarkers(
  source: string,
  id: string,
  version?: number
): { start: string; end: string; startIndex: number; endIndex: number } | null {
  assertBlockId(id);
  assertExactMarkerSyntax(source);
  const escapedId = escapeRegExp(id);
  const startMatches = [
    ...source.matchAll(
      new RegExp(
        `<!-- agent-ops:start ${escapedId} v[0-9]+ -->`,
        "g"
      )
    )
  ];
  const end = `<!-- agent-ops:end ${id} -->`;
  const endMatches = [...source.matchAll(new RegExp(escapeRegExp(end), "g"))];

  if (startMatches.length === 0 && endMatches.length === 0) {
    return null;
  }
  const expectedStart =
    version === undefined ? startMatches[0]?.[0] : managedBlockMarkers(id, version).start;
  const start = startMatches[0]?.[0];
  const startIndex = startMatches[0]?.index;
  const endIndex = endMatches[0]?.index;
  if (
    startMatches.length !== 1 ||
    endMatches.length !== 1 ||
    start === undefined ||
    expectedStart === undefined ||
    start !== expectedStart ||
    startIndex === undefined ||
    endIndex === undefined ||
    startIndex >= endIndex
  ) {
    throw new AgentOpsError(
      "MALFORMED_MANAGED_BLOCK",
      `Managed block markers are missing, duplicated, reversed, or version-mismatched: ${id}`
    );
  }
  return { start, end, startIndex, endIndex };
}

function renderBlock(options: ManagedBlockOptions): string {
  if (/<!--\s*agent-ops:/.test(options.content)) {
    throw new AgentOpsError(
      "AMBIGUOUS_MANAGED_CONTENT",
      "Managed content must not contain agent-ops marker boundaries."
    );
  }
  const { start, end } = managedBlockMarkers(options.id, options.version);
  const content = options.content.replace(/\r\n/g, "\n").replace(/\n+$/g, "");
  return `${start}\n${content}\n${end}`;
}

export function applyManagedBlock(
  source: string,
  options: ManagedBlockOptions
): string {
  const block = renderBlock(options);
  const located = locateMarkers(source, options.id, options.version);
  if (located === null) {
    if (source.length === 0) {
      return `${block}\n`;
    }
    return `${source.replace(/\n*$/, "\n\n")}${block}\n`;
  }
  return `${source.slice(0, located.startIndex)}${block}${source.slice(
    located.endIndex + located.end.length
  )}`;
}

export function removeManagedBlock(source: string, id: string): string {
  const located = locateMarkers(source, id);
  if (located === null) {
    return source;
  }
  let before = source.slice(0, located.startIndex);
  let after = source.slice(located.endIndex + located.end.length);
  if (before.length === 0 && after === "\n") {
    return "";
  }
  if (before.endsWith("\n\n") && after.startsWith("\n")) {
    before = before.slice(0, -1);
    after = after.slice(1);
  }
  return `${before}${after}`;
}
