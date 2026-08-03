import { AgentOpsError } from "./paths.js";

export interface ManagedBlockOptions {
  id: string;
  version: number;
  content: string;
  markerStyle?: ManagedBlockMarkerStyle;
}

export type ManagedBlockMarkerStyle = "hash" | "html";

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

function assertExactMarkerSyntax(
  source: string,
  markerStyle: ManagedBlockMarkerStyle
): void {
  const validMarker = markerStyle === "html"
    ? /^<!-- agent-ops:(?:start [a-z][a-z0-9-]{0,127} v[1-9][0-9]*|end [a-z][a-z0-9-]{0,127}) -->$/
    : /^# agent-ops:(?:start [a-z][a-z0-9-]{0,127} v[1-9][0-9]*|end [a-z][a-z0-9-]{0,127})$/;
  const markerPrefix = markerStyle === "html"
    ? /<!--\s*agent-ops:/
    : /#\s*agent-ops:/;
  for (const line of source.split(/\r?\n/)) {
    if (markerPrefix.test(line) && !validMarker.test(line)) {
      throw new AgentOpsError(
        "MALFORMED_MANAGED_BLOCK",
        "Managed block markers must use the exact agent-ops marker syntax."
      );
    }
  }
}

export function managedBlockMarkers(
  id: string,
  version: number,
  markerStyle: ManagedBlockMarkerStyle = "html"
): ManagedBlockMarkers {
  assertBlockId(id);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new AgentOpsError(
      "INVALID_BLOCK_VERSION",
      `Invalid block version: ${version}`
    );
  }
  return markerStyle === "html"
    ? {
        start: `<!-- agent-ops:start ${id} v${version} -->`,
        end: `<!-- agent-ops:end ${id} -->`
      }
    : {
        start: `# agent-ops:start ${id} v${version}`,
        end: `# agent-ops:end ${id}`
      };
}

function locateMarkers(
  source: string,
  id: string,
  version?: number,
  markerStyle: ManagedBlockMarkerStyle = "html"
): { start: string; end: string; startIndex: number; endIndex: number } | null {
  assertBlockId(id);
  assertExactMarkerSyntax(source, markerStyle);
  const escapedId = escapeRegExp(id);
  const startPattern = markerStyle === "html"
    ? `<!-- agent-ops:start ${escapedId} v[0-9]+ -->`
    : `# agent-ops:start ${escapedId} v[0-9]+`;
  const end = markerStyle === "html"
    ? `<!-- agent-ops:end ${id} -->`
    : `# agent-ops:end ${id}`;
  const startMatches = [
    ...source.matchAll(
      new RegExp(startPattern, "g")
    )
  ];
  const endMatches = [...source.matchAll(new RegExp(escapeRegExp(end), "g"))];

  if (startMatches.length === 0 && endMatches.length === 0) {
    return null;
  }
  const expectedStart =
    version === undefined
      ? startMatches[0]?.[0]
      : managedBlockMarkers(id, version, markerStyle).start;
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
  if (/(?:<!--|#)\s*agent-ops:/.test(options.content)) {
    throw new AgentOpsError(
      "AMBIGUOUS_MANAGED_CONTENT",
      "Managed content must not contain agent-ops marker boundaries."
    );
  }
  const { start, end } = managedBlockMarkers(
    options.id,
    options.version,
    options.markerStyle
  );
  const content = options.content.replace(/\r\n/g, "\n").replace(/\n+$/g, "");
  return `${start}\n${content}\n${end}`;
}

export function applyManagedBlock(
  source: string,
  options: ManagedBlockOptions
): string {
  const block = renderBlock(options);
  const located = locateMarkers(
    source,
    options.id,
    options.version,
    options.markerStyle
  );
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

export function removeManagedBlock(
  source: string,
  id: string,
  markerStyle: ManagedBlockMarkerStyle = "html"
): string {
  const located = locateMarkers(source, id, undefined, markerStyle);
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
