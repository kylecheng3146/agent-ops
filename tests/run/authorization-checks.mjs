import assert from 'node:assert/strict';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const build = resolve(process.env.AGENT_OPS_DEBUG_TEST_BUILD ?? 'dist');
const mod = path => import(pathToFileURL(join(build, path)).href);
const {calculateConfigHash, canonicalJson} = await mod('runtime/src/config/hash.js');
const {sha256} = await mod('runtime/src/fs/hash.js');
const {bindRunPolicy} = await mod('runtime/src/run/policy.js');
const {FileRunRepository, createRunState} = await mod('runtime/src/run/service.js');
const {recordNativeRunAuthorization} = await mod('runtime/src/run/authorization.js');
const {readPrivateFile} = await mod('runtime/src/security/permissions.js');

const config = {schemaVersion: 3, profiles: ['core'], verification: {commands: []},
  features: {completionGate: {enabled: true}, stopVerification: {enabled: false}}, pathMappings: [], securityExceptions: []};

/** Native scopes are observations; their size must never block the run they describe. */
export const authorizationChecks = {
  'large-native-authorization': async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-ops-large-auth-')));
    const common = join(root, '.git');
    try {
      const repository = new FileRunRepository(join(common, 'agent-ops/runs'), common);
      const state = createRunState({root, commonDir: common, targetBranch: 'main', goal: 'Large scope fixture', host: 'claude', ownerSessionId: 'owner'});
      await repository.create(state);
      await bindRunPolicy(repository, state.runId, {config, runtimeHash: 'b'.repeat(64),
        baseTrustBinding: {canonicalPath: root, remoteIdentity: 'local:fixture', configHash: calculateConfigHash(config), runtimeHash: 'a'.repeat(64)}});
      await repository.mutate(state.runId, s => ({...s, workers: [{workerId: 'writer', taskId: 'task', host: 'claude', ownerSessionId: 'owner',
        nativeSessionId: 'native', nativeJobId: 'thread', worktree: root, processId: null, processIdentity: null, generation: 1,
        status: 'running', leaseExpiresAt: null, heartbeatAt: null, stopIntent: null, nativeGoalState: 'active', lastFailure: null}]}));
      const event = (host, payload, transportMethod) => ({host, payload, ...(transportMethod === undefined ? {} : {transportMethod}),
        runId: state.runId, workerId: 'writer', generation: 1, contractHash: state.goalHash, type: 'message', nativeStatus: 'active',
        at: new Date().toISOString(), proof: false});
      const record = async payload => {
        try {await recordNativeRunAuthorization(repository, payload);}
        catch (error) {assert.fail(`oversized native scope was rejected: ${error.code ?? error.message}`);}
      };
      const input = {file_path: join(root, 'tests/large.mjs'), content: 'export const rows = [\n' + '  "row",\n'.repeat(5_000) + '];\n'};
      assert.ok(canonicalJson(input).length > 32 * 1024);
      await record(event('claude', {type: 'assistant', message: {content: [{type: 'tool_use', id: 'tool-large', name: 'Write', input}]}}));
      let current = await repository.read(state.runId);
      assert.equal(current.status, 'active');
      const observed = current.events.at(-1);
      assert.equal(observed.code, 'RUN_COMMAND_AUTHORIZATION_OBSERVED');
      const artifact = JSON.parse(await readPrivateFile(JSON.parse(observed.detail).artifact, common));
      assert.ok(artifact.command.length <= 32 * 1024, 'stored scope stays bounded');
      assert.ok(artifact.command.includes(sha256(canonicalJson(input))), 'stored scope identifies the full input');
      const patch = {type: 'applyPatch', cwd: root, files: ['large.txt'], patch: '+line\n'.repeat(8_000)};
      await record(event('codex', {reviewId: 'review-large', threadId: 'thread', decisionSource: 'agent', action: patch,
        review: {status: 'approved', rationale: 'Local patch'}}, 'item/autoApprovalReview/completed'));
      current = await repository.read(state.runId);
      assert.equal(current.status, 'active');
      assert.equal(current.events.at(-1).code, 'RUN_COMMAND_AUTO_APPROVED');
    } finally {await rm(root, {recursive: true, force: true});}
  }
};
