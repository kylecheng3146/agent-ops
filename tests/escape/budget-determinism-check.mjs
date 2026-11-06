import assert from 'node:assert/strict';
import childProcess, {execFile} from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {ruleChecks} from './rule-checks.mjs';

export const budgetDeterminismChecks = {
  'escape-budget-deterministic': async () => {
    const original = childProcess.execFile;
    let failNormalLog = false;
    // A fast real Git must not make the committed timeout regression flaky.
    const fastGit = (command, args, options, callback) => {
      if (command === 'git' && args[0] === 'log') {
        if (failNormalLog && options.timeout !== 1) {
          queueMicrotask(() => callback(Object.assign(new Error('Injected Git failure'), {code: 1}), Buffer.alloc(0)));
          return;
        }
        if (options.timeout === 1) return original(command, args, {...options, timeout: 30_000}, callback);
      }
      return original(command, args, options, callback);
    };
    childProcess.execFile = fastGit;
    syncBuiltinESMExports();
    try {
      await ruleChecks['escape-backtest-budget-cache']();
      assert.equal(childProcess.execFile, fastGit, 'Restore the caller subprocess implementation after success');
      assert.equal(execFile, fastGit, 'Restore named builtin exports after success');
      failNormalLog = true;
      await assert.rejects(ruleChecks['escape-backtest-budget-cache'](), /ESCAPE_GIT_FAILED/u);
      assert.equal(childProcess.execFile, fastGit, 'Restore the caller subprocess implementation after failure');
      assert.equal(execFile, fastGit, 'Restore named builtin exports after failure');
    } finally {
      childProcess.execFile = original;
      syncBuiltinESMExports();
    }
  }
};
