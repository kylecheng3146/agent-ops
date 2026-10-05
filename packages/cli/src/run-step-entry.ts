import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";

/** Dormant process group: the supervisor records this PID before releasing the CLI. */
const cli = fileURLToPath(new URL("./bin.js", import.meta.url));
const setup = fileURLToPath(new URL("./run-setup-entry.js", import.meta.url));
const target = process.argv[2];
if (target !== cli && target !== setup) throw new Error("Run proof entry must use its own installed execution entry.");
let input = "";
let started = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  if (started) return;
  input += chunk;
  if (input.length > 16 || (input.includes("\n") && input !== "start\n")) process.exit(1);
  if (input !== "start\n") return;
  started = true;
  // Keep this identity alive until the CLI finishes its signal cleanup.
  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});
  process.stdin.pause();
  process.env.AGENT_OPS_RUN_PROOF_PID = String(process.pid);
  const child = spawn(process.execPath, [target!, ...process.argv.slice(3)], {env: process.env, stdio: ["ignore", "inherit", "inherit"]});
  child.once("error", () => process.exit(1));
  child.once("close", (code, signal) => {
    const deadline = Date.now() + 3000;
    const reconcile = (): void => {
      const listing = spawn("ps", ["-axo", "pid=,pgid="], {detached: true, stdio: ["ignore", "pipe", "ignore"]});
      let output = "";
      listing.stdout.on("data", chunk => {output += chunk.toString();});
      listing.once("error", () => process.kill(-process.pid, "SIGKILL"));
      listing.once("close", status => {
        if (status !== 0) process.kill(-process.pid, "SIGKILL");
        const remaining = output.split("\n").some(line => {
          const [pid, group] = line.trim().split(/\s+/u).map(Number);
          return group === process.pid && pid !== process.pid;
        });
        if (remaining && Date.now() < deadline) {setTimeout(reconcile, 50); return;}
        if (remaining) process.kill(-process.pid, "SIGKILL");
        else if (signal !== null) process.exit(1);
        else process.exit(code ?? 1);
      });
    };
    reconcile();
  });
});
process.stdin.on("end", () => {if (!started) process.exit(1);});
