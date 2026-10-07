import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {copyFile, mkdtemp, writeFile, readFile, rm, realpath} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {setTimeout as delay} from "node:timers/promises";
import test from "node:test";

test("proof process stays dormant until released, and EOF cannot execute a CLI", {skip: process.platform === "win32"}, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-ops-proof-process-")));
  try {
    const entry = join(root, "run-step-entry.js");
    const cli = join(root, "bin.js");
    const marker = join(root, "started");
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await copyFile(fileURLToPath(new URL("../../packages/cli/src/run-step-entry.js", import.meta.url)), entry);
    await writeFile(cli, "import {writeFileSync} from 'node:fs'; writeFileSync(process.argv[2], 'started'); console.log('proof');");
    const child = spawn(process.execPath, [entry, cli, marker], {detached: true, stdio: ["pipe", "pipe", "pipe"]});
    const closed = new Promise<number | null>(resolve => child.once("close", resolve));
    let output = "";
    let diagnostic = "";
    child.stderr.on("data", chunk => {diagnostic += chunk.toString();});
    child.stdout.on("data", chunk => {output += chunk.toString();});
    await delay(150);
    await assert.rejects(readFile(marker), {code: "ENOENT"});
    child.stdin.end("start\n");
    assert.equal(await closed, 0, diagnostic);
    assert.equal(await readFile(marker, "utf8"), "started");
    assert.equal(output.trim(), "proof");
    await rm(marker);
    const cancelled = spawn(process.execPath, [entry, cli, marker], {detached: true, stdio: ["pipe", "pipe", "pipe"]});
    const cancelledExit = new Promise<number | null>(resolve => cancelled.once("close", resolve));
    cancelled.stdin.end();
    assert.equal(await cancelledExit, 1);
    await assert.rejects(readFile(marker), {code: "ENOENT"});
  } finally {await rm(root, {recursive: true, force: true});}
});

test("canceling a registered proof group kills a TERM-resistant managed descendant", {skip: process.platform === "win32"}, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-ops-proof-cancel-")));
  let group: number | undefined;
  try {
    const entry = join(root, "run-step-entry.js");
    const cli = join(root, "bin.js");
    const marker = join(root, "descendant");
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await copyFile(fileURLToPath(new URL("../../packages/cli/src/run-step-entry.js", import.meta.url)), entry);
    const runner = new URL("../../runtime/src/verify/spawn.js", import.meta.url).href;
    const program = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`;
    await writeFile(cli, `import {registeredRunProofRunner} from ${JSON.stringify(runner)}; const child=registeredRunProofRunner().start({command:process.execPath,args:['-e',${JSON.stringify(program)}],cwd:process.cwd(),shell:false}); await child.completion;`);
    const child = spawn(process.execPath, [entry, cli], {detached: true, stdio: ["pipe", "pipe", "pipe"]});
    group = child.pid;
    const closed = new Promise<{code: number | null; signal: string | null}>(resolve => child.once("close", (code, signal) => resolve({code, signal})));
    child.stdin.end("start\n");
    let pid: number | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {pid = Number(await readFile(marker, "utf8")); break;} catch {await delay(20);}
    }
    assert.ok(pid);
    process.kill(-child.pid!, "SIGTERM");
    assert.equal((await closed).signal, "SIGKILL");
    let alive = true;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {process.kill(pid!, 0); await delay(20);} catch {alive = false; break;}
    }
    assert.equal(alive, false, "managed subprocess cannot survive a stopped proof group");
  } finally {
    if (group !== undefined) try {process.kill(-group, "SIGKILL");} catch {}
    await rm(root, {recursive: true, force: true});
  }
});
