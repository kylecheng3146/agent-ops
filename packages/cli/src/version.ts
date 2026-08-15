import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type PackageMetadata = {
  name?: unknown;
  version?: unknown;
};

function readPackageVersion(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (true) {
    try {
      const metadata = JSON.parse(
        readFileSync(join(directory, "package.json"), "utf8")
      ) as PackageMetadata;
      if (
        metadata.name === "@kylecheng3146/agent-ops" &&
        typeof metadata.version === "string"
      ) {
        return metadata.version;
      }
    } catch {
      // Keep walking until the package root is found.
    }
    const parent = dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  throw new Error("Unable to locate the package version.");
}

// package.json is the single source of the published CLI version.
export const CLI_VERSION = readPackageVersion();
