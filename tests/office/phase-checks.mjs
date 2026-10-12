import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {Readable} from 'node:stream';
import {pathToFileURL} from 'node:url';

const build = resolve(process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist');
const mod = path => import(pathToFileURL(join(build, path)).href);
const {officeLoopPhaseHint} = await mod('packages/cli/src/office-entry.js');
const {buildCodexHookConfig} = await mod('runtime/src/adapters/codex/config.js');
const {runHookProcess} = await mod('packages/cli/src/hook-process.js');
const {runLoopProcess} = await mod('packages/cli/src/codex-loop-process.js');

async function observed(input, expected) {
  const root = await mkdtemp(join(tmpdir(), 'agent-ops-office-phase-'));
  const config = {schemaVersion: 3, profiles: ['core'], verification: {commands: []},
    features: {office: {enabled: true}, completionGate: {enabled: false}, stopVerification: {enabled: false}}, pathMappings: [], securityExceptions: []};
  try {
    await mkdir(join(root, '.agent-ops')); await mkdir(join(root, '.codex'));
    await writeFile(join(root, '.agent-ops/config.json'), JSON.stringify(config));
    for (const loop of [false, true]) {
      const seen = [], output = [];
      const io = {stdin: Readable.from([JSON.stringify({cwd: root, session_id: 'phase-probe', hook_event_name: 'PreToolUse', ...input})]),
        writeStdout: text => output.push(text), writeStderr: text => output.push(text)};
      const deps = {root, office: async event => {seen.push(event);}, loadConfig: async () => config, trust: async () => 'TRUSTED'};
      const exit = loop ? await runLoopProcess(['codex', 'PreToolUse'], io, deps) : await runHookProcess(['codex', 'PreToolUse'], io, 'test', deps);
      assert.equal(exit, 0); assert.deepEqual(output, []);
      assert.equal(seen[0]?.phase, expected, loop ? 'project loop phase' : 'ordinary hook phase');
    }
  } finally {await rm(root, {recursive: true, force: true});}
}

export const officePhaseChecks = {
  'office-codex-edit': async () => {
    for (const capabilities of [['office-presence'], ['project-loop', 'office-presence']]) {
      const config = buildCodexHookConfig(capabilities, '/opt/agent-ops/hook-entry.js');
      const matcher = new RegExp(config.hooks.PreToolUse[0].matcher);
      assert.equal(matcher.test('apply_patch'), true, 'Office must receive native Codex edits');
      assert.equal(matcher.test('Bash'), true); assert.equal(matcher.test('mcp__fs__apply_patch'), false);
      if (config.hooks.PermissionRequest) assert.equal(config.hooks.PermissionRequest[0].matcher, '^Bash$');
    }
    assert.equal(buildCodexHookConfig(['command-policy'], '/opt/hook-entry.js').hooks.PreToolUse[0].matcher, '^Bash$');
    assert.equal(buildCodexHookConfig(['project-loop'], '/opt/hook-entry.js').hooks.PreToolUse[0].matcher, '^Bash$');
    await observed({tool_name: 'apply_patch', tool_input: {command: '*** Begin Patch\n*** End Patch'}}, 'implementing');
    for (const tool_input of [null, {}, {command: ''}, {command: 1}])
      assert.equal(officeLoopPhaseHint({tool_name: 'apply_patch', tool_input}, '/repo'), undefined);
  },
  'office-wrapped-review': async () => {
    await observed({tool_name: 'Bash', tool_input: {command: 'env -u CODEX_SANDBOX_NETWORK_DISABLED AGENT_OPS_HOST=codex agent-ops review --task test --yes'}}, 'reviewing');
    await observed({tool_name: 'Bash', tool_input: {cmd: 'agent-ops verify --task test'}}, 'verifying');
    assert.equal(officeLoopPhaseHint({tool_name: 'Bash', tool_input: {command: 'env -u FIRST --unset=SECOND --unset THIRD -- HOST=codex env agent-ops review'}}, '/repo'), 'reviewing');
    for (const command of ['echo agent-ops review', 'env --unknown agent-ops review', 'env -u agent-ops review', 'npm test', 'node tools/verify.js'])
      assert.equal(officeLoopPhaseHint({tool_name: 'Bash', tool_input: {command}}, '/repo'), undefined, command);
  },
  'office-node-verify': async () => {
    await observed({tool_name: 'Bash', tool_input: {command: 'node dist/packages/cli/src/bin.js verify --task test'}}, 'verifying');
    assert.equal(officeLoopPhaseHint({tool_name: 'Bash', tool_input: {command: `env -u DISABLED node '${join(build, 'packages/cli/src/bin.js')}' review --task test`}}, '/repo'), 'reviewing');
    assert.equal(officeLoopPhaseHint({tool_name: 'Bash', tool_input: {command: 'node other/packages/cli/src/bin.js verify'}}, '/repo'), undefined);
  }
};
