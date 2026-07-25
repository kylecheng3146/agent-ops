import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CliResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function runBuiltCli(
  args: readonly string[],
  root = mkdtempSync(join(tmpdir(), "agent-ops-e2e-")),
  home = root
): { readonly result: CliResult; readonly root: string } {
  try {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let status = 0;
    try {
      stdout.push(
        execFileSync(
          process.execPath,
          [join(process.cwd(), ".tmp/test-dist/packages/cli/src/bin.js"), ...args],
          {
            cwd: root,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, AGENT_OPS_HOME: home }
          }
        )
      );
    } catch (error) {
      const failure = error as {
        status?: number | null;
        stdout?: string | Buffer;
        stderr?: string | Buffer;
      };
      status = failure.status ?? 1;
      stdout.push(String(failure.stdout ?? ""));
      stderr.push(String(failure.stderr ?? ""));
    }
    return {
      root,
      result: { status, stdout: stdout.join(""), stderr: stderr.join("") }
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function cleanupE2eRoot(root: string): void {
  rmSync(root, { recursive: true, force: true });
}
