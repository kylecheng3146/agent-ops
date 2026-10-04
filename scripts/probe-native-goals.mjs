#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const timeoutMs = Number(process.argv[process.argv.indexOf("--timeout-ms") + 1]) || 20_000;
const outArgIndex = process.argv.indexOf("--out");
const outputPath = outArgIndex >= 0
  ? process.argv[outArgIndex + 1]
  : join(tmpdir(), `agent-ops-native-goal-probe-${Date.now()}.json`);
const hostArgIndex = process.argv.indexOf("--host");
const selectedHost = hostArgIndex >= 0 ? process.argv[hostArgIndex + 1] : "all";

function now() {
  return new Date().toISOString();
}

function eventSummary(value) {
  if (!value || typeof value !== "object") return { kind: "invalid" };
  const type = typeof value.type === "string" ? value.type : undefined;
  const subtype = typeof value.subtype === "string" ? value.subtype : undefined;
  const method = typeof value.method === "string" ? value.method : undefined;
  const status = typeof value.status === "string" ? value.status : undefined;
  const sessionId = typeof value.session_id === "string" ? value.session_id : undefined;
  const params = value.params && typeof value.params === "object" ? value.params : undefined;
  return {
    ...(type ? { type } : {}),
    ...(subtype ? { subtype } : {}),
    ...(method ? { method } : {}),
    ...(status ? { status } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(params && typeof params.method === "string" ? { nestedMethod: params.method } : {})
  };
}

function lineProcess(command, args, cwd, env = {}) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const lines = [];
  const errors = [];
  const stdout = createInterface({ input: child.stdout });
  const stderr = createInterface({ input: child.stderr });
  stdout.on("line", (line) => {
    try {
      lines.push(JSON.parse(line));
    } catch {
      lines.push({ type: "non-json", text: line.slice(0, 240) });
    }
  });
  stderr.on("line", (line) => errors.push(line.slice(0, 240)));
  const exit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
  const waitFor = async (predicate, waitMs) => {
    const started = Date.now();
    while (Date.now() - started < waitMs) {
      const value = lines.find(predicate);
      if (value !== undefined) return value;
      if (child.exitCode !== null || child.signalCode !== null) return undefined;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return undefined;
  };
  const stop = async (signal = "SIGINT") => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    const deadline = Date.now() + 5_000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    return exit;
  };
  return { child, lines, errors, send, waitFor, stop, exit };
}

async function runClaude(cwd) {
  const sessionId = randomUUID();
  const args = [
    "-p", "--session-id", sessionId,
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose", "--include-partial-messages",
    "--permission-mode", "auto",
    "--permission-prompts", "none"
  ];
  const prompt = "/goal Create native-goal-probe.txt containing exactly agent-ops-native-probe, then keep this goal active until turn 10 or until interrupted.";
  const startedAt = now();
  const first = lineProcess("claude", args, cwd);
  first.send({ type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] } });
  const init = await first.waitFor((value) => value.type === "system" && value.subtype === "init", Math.min(timeoutMs, 10_000));
  await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs, 5_000)));
  const stopExit = await first.stop("SIGINT");
  const resumedSession = init?.session_id ?? sessionId;
  const resumeArgs = [
    "-p", "--resume", resumedSession,
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose", "--include-partial-messages",
    "--permission-mode", "auto",
    "--permission-prompts", "none"
  ];
  const second = lineProcess("claude", resumeArgs, cwd);
  second.send({ type: "user", message: { role: "user", content: [{ type: "text", text: "Continue toward the active native goal and keep it active until turn 10 or interruption." }] } });
  const resumeInit = await second.waitFor((value) => value.type === "system" && value.subtype === "init", Math.min(timeoutMs, 10_000));
  await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs, 5_000)));
  const resumeExit = await second.stop("SIGINT");
  return {
    host: "claude",
    command: ["claude", ...args],
    startedAt,
    requestedSessionId: sessionId,
    init: init === undefined ? null : eventSummary(init),
    goalInputSent: init !== undefined,
    stopExit,
    events: first.lines.map(eventSummary),
    stderr: first.errors,
    resume: {
      requestedSessionId: resumedSession,
      init: resumeInit === undefined ? null : eventSummary(resumeInit),
      inputSent: resumeInit !== undefined,
      exit: resumeExit,
      events: second.lines.map(eventSummary),
      stderr: second.errors
    }
  };
}

function rpcProcess(cwd) {
  const processHandle = lineProcess("codex", ["app-server", "--listen", "stdio://"], cwd);
  let requestId = 0;
  const request = async (method, params, waitMs = 10_000) => {
    const id = ++requestId;
    processHandle.send({ jsonrpc: "2.0", id, method, params });
    const response = await processHandle.waitFor((value) => value.id === id, waitMs);
    if (response?.error) throw new Error(`${method}: ${JSON.stringify(response.error).slice(0, 240)}`);
    return response?.result ?? response;
  };
  const notify = (method, params = {}) => processHandle.send({ jsonrpc: "2.0", method, params });
  return { ...processHandle, request, notify };
}

async function runCodex(cwd) {
  const startedAt = now();
  const first = rpcProcess(cwd);
  const initialize = await first.request("initialize", {
    clientInfo: { name: "agent-ops-probe", title: "agent-ops native goal probe", version: "0.5.3" }
  }, Math.min(timeoutMs, 10_000));
  first.notify("initialized");
  const threadStart = initialize === undefined ? undefined : await first.request("thread/start", {
    cwd,
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
    sandbox: "workspace-write",
    ephemeral: false
  }, Math.min(timeoutMs, 10_000));
  const threadId = threadStart?.thread?.id;
  let goalSet;
  let turnStart;
  if (typeof threadId === "string") {
    goalSet = await first.request("thread/goal/set", {
      threadId,
      objective: "Create native-goal-probe.txt containing exactly agent-ops-native-probe, then keep this goal active until turn 10 or until interrupted.",
      status: "active",
      tokenBudget: 512
    }, Math.min(timeoutMs, 10_000));
    turnStart = await first.request("turn/start", {
      threadId,
      input: [{ type: "text", text: "Work toward the configured goal." }],
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review"
    }, Math.min(timeoutMs, 10_000));
  }
  await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs, 5_000)));
  const turnId = turnStart?.turn?.id;
  if (typeof threadId === "string" && typeof turnId === "string") {
    await first.request("turn/interrupt", { threadId, turnId }, 5_000).catch(() => undefined);
  }
  if (typeof threadId === "string") {
    await first.request("thread/goal/set", { threadId, objective: null, status: "paused", tokenBudget: null }, 5_000).catch(() => undefined);
  }
  const stopExit = await first.stop("SIGTERM");
  const second = rpcProcess(cwd);
  const resumeInitialize = await second.request("initialize", {
    clientInfo: { name: "agent-ops-probe", title: "agent-ops native goal probe", version: "0.5.3" }
  }, Math.min(timeoutMs, 10_000));
  second.notify("initialized");
  const resume = typeof threadId === "string"
    ? await second.request("thread/resume", {
        threadId,
        cwd,
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandbox: "workspace-write",
        excludeTurns: true
      }, Math.min(timeoutMs, 10_000))
    : undefined;
  await second.stop("SIGTERM");
  return {
    host: "codex",
    command: ["codex", "app-server", "--listen", "stdio://"],
    startedAt,
    initialize: initialize === undefined ? null : eventSummary(initialize),
    threadStart: threadStart === undefined ? null : eventSummary(threadStart),
    threadId: typeof threadId === "string" ? threadId : null,
    goalSet: goalSet === undefined ? null : eventSummary(goalSet),
    turnStart: turnStart === undefined ? null : eventSummary(turnStart),
    stopExit,
    events: first.lines.map(eventSummary),
    stderr: first.errors,
    resumeInitialize: resumeInitialize === undefined ? null : eventSummary(resumeInitialize),
    resume: resume === undefined ? null : eventSummary(resume),
    resumeEvents: second.lines.map(eventSummary),
    resumeStderr: second.errors
  };
}

async function main() {
  const probeRoot = await mkdtemp(join(tmpdir(), "agent-ops-native-goal-probe-"));
  await writeFile(join(probeRoot, "README.md"), "isolated native goal probe\n", "utf8");
  await execFile("git", ["init", "--quiet"], { cwd: probeRoot });
  const evidence = {
    schema: 1,
    generatedAt: now(),
    timeoutMs,
    probeRoot,
    safety: {
      isolatedTempRepo: true,
      bypassFlags: false,
      globalPolicyChanged: false,
      nativeCompletionCountsAsProof: false
    },
    versions: {
      claude: await execFile("claude", ["--version"]).then((result) => result.stdout.trim()).catch((error) => `unavailable: ${String(error)}`),
      codex: await execFile("codex", ["--version"]).then((result) => result.stdout.trim()).catch((error) => `unavailable: ${String(error)}`)
    },
    claude: null,
    codex: null
  };
  try {
    if (selectedHost === "all" || selectedHost === "claude") {
      evidence.claude = await runClaude(probeRoot).catch((error) => ({ status: "error", error: String(error) }));
    }
    if (selectedHost === "all" || selectedHost === "codex") {
      evidence.codex = await runCodex(probeRoot).catch((error) => ({ status: "error", error: String(error) }));
    }
  } finally {
    await rm(probeRoot, { recursive: true, force: true });
  }
  await mkdir(join(outputPath, ".."), { recursive: true }).catch(() => undefined);
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  const status = (value) => value === null ? "skipped" : (value?.status ?? "observed");
  process.stdout.write(`${JSON.stringify({ outputPath, claude: status(evidence.claude), codex: status(evidence.codex) })}\n`);
}

await main();
