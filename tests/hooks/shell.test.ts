import assert from "node:assert/strict";
import test from "node:test";

import { normalizeShellHookEvent } from "../../runtime/src/hooks/shell.js";

const ROOT = "/repo";

function commandsOf(input: string): Array<{ command: string; args: readonly string[] }> {
  const event = normalizeShellHookEvent(input, ROOT);
  if (event.event === "command") {
    return [{ command: event.command, args: event.args }];
  }
  if (event.event === "command-batch") {
    return event.commands.map(({ command, args }) => ({ command, args }));
  }
  return [];
}

test("a variable reference is a word, not a reason to give up", () => {
  const event = normalizeShellHookEvent("cat $file ${other}", ROOT);
  assert.equal(event.event, "command");
  assert.deepEqual(commandsOf("cat $file ${other}"), [
    { command: "cat", args: ["$file", "${other}"] }
  ]);
});

test("a command hidden in a substitution is still inspected", () => {
  for (const input of ["echo $(rm -rf /tmp/x)", "echo `rm -rf /tmp/x`"]) {
    const commands = commandsOf(input);
    assert.deepEqual(
      commands.map(({ command }) => command),
      ["echo", "rm"],
      input
    );
    assert.deepEqual(commands[1]?.args, ["-rf", "/tmp/x"], input);
  }
});

test("substitutions nest", () => {
  assert.deepEqual(
    commandsOf("echo $(dirname $(command -v node))").map(({ command }) => command),
    ["echo", "dirname", "command"]
  );
});

test("a subshell contributes its commands instead of ending the parse", () => {
  assert.deepEqual(
    commandsOf("(cd /tmp && rm -rf x)").map(({ command }) => command),
    ["cd", "rm"]
  );
});

test("a heredoc body is data, never commands", () => {
  const commands = commandsOf("cat > out <<'EOF'\nrm -rf /\nEOF\nls\n");
  assert.deepEqual(commands.map(({ command }) => command), ["cat", "ls"]);
});

test("an expanding heredoc body cannot smuggle a command past the policy", () => {
  // Unquoted delimiter: the shell expands the body, so its substitution runs.
  assert.deepEqual(
    commandsOf("cat <<EOF\n$(git push --force origin main)\nEOF\n")
      .map(({ command }) => command),
    ["cat", "git"]
  );
  // Quoted delimiter: the body is literal text and stays out of the policy.
  assert.deepEqual(
    commandsOf("cat <<'EOF'\n$(git push --force origin main)\nEOF\n")
      .map(({ command }) => command),
    ["cat"]
  );
});

test("a quoted heredoc marker is text, not a heredoc", () => {
  assert.deepEqual(
    commandsOf("echo '<<EOF'; git push --force origin main")
      .map(({ command }) => command),
    ["echo", "git"]
  );
});

test("a quoted parenthesis does not end a substitution early", () => {
  assert.deepEqual(
    commandsOf("echo $(printf ')'; git push --force origin main)")
      .map(({ command }) => command),
    ["echo", "printf", "git"]
  );
});

test("a substitution inside double quotes is still a command", () => {
  assert.deepEqual(
    commandsOf("echo \"$(git push --force origin main)\"")
      .map(({ command }) => command),
    ["echo", "git"]
  );
});

test("input that cannot be read honestly stays unsupported", () => {
  for (const input of [
    "cat <<EOF\nnever closed\n",
    "echo $(rm -rf /tmp/x",
    "echo 'unbalanced",
    ""
  ]) {
    assert.equal(normalizeShellHookEvent(input, ROOT).event, "unsupported", input);
  }
});
