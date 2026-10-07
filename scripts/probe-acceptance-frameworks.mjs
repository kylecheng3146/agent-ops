// Bounded real-framework probes. Tools are supplied explicitly; no installation or downloads.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {collectPytestAcceptance} from '../dist/runtime/src/verify/adapters/pytest.js';
import {collectRustAcceptance} from '../dist/runtime/src/verify/adapters/rust.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const options={executionId:'framework-probe',phase:'candidate',frameworkVersion:'probe'};
const input=process.argv.slice(2);
const allowed=new Set(['--pytest-python','--rustc','--out']);
const args=new Map();
for(let i=0;i<input.length;i+=2){
  assert(allowed.has(input[i]) && input[i+1] && !args.has(input[i]),'Supply unique --pytest-python, --rustc, --out options');
  args.set(input[i],input[i+1]);
}
assert(args.has('--pytest-python') && args.has('--rustc'),'Both real framework tools are required');
const directory=mkdtempSync(join(tmpdir(),'agent-ops-framework-'));
const execute=(command,argv)=>spawnSync(command,argv,{cwd:directory,encoding:'utf8',timeout:15000,maxBuffer:1024*1024});
const results={};
try{
  writeFileSync(join(directory,'test_contract.py'),`import pytest

def test_green(): assert 1 == 1

def test_red(): assert 1 == 2

@pytest.fixture
def broken(): raise AssertionError('setup failure is not red')

def test_fixture(broken): pass

@pytest.mark.xfail(reason='not proof')
def test_xfail(): assert False

@pytest.mark.skip(reason='not proof')
def test_skip(): pass
`);
  const pytest=execute(args.get('--pytest-python'),[join(root,'templates/acceptance/agent_ops_pytest.py'),'test_contract.py']);
  assert.equal(pytest.error,undefined); assert.equal(pytest.status,1);
  const pytestVersion=execute(args.get('--pytest-python'),['-m','pytest','--version']).stdout.trim();
  const pythonRun=collectPytestAcceptance(pytest.stdout,{...options,frameworkVersion:pytestVersion});
  assert(pythonRun.completed); assert.deepEqual(pythonRun.diagnostics,[]);
  for(const [name,status,kind] of [['green','PASS','none'],['red','FAIL','assertion-failed'],['fixture','UNKNOWN','fixture-error'],['xfail','UNKNOWN','xfail'],['skip','UNKNOWN','fixture-error']]){
    const result=pythonRun.results.find(r=>r.checkId===`test_contract.py::test_${name}`);
    assert.equal(result?.status,status);assert.equal(result?.failureClass,kind);
  }
  results.pytest={version:pytestVersion,run:pythonRun};
  const module=join(root,'templates/acceptance/agent_ops_acceptance.rs');
  writeFileSync(join(directory,'check.rs'),`#[path=${JSON.stringify(module)}] mod acceptance;
fn main(){let mut h=acceptance::Harness::new();h.check("green",||Ok(()));h.check("red",||Err("assertion".to_string()));h.check("panic",||{panic!("infrastructure")});h.finish();}`);
  const build=execute(args.get('--rustc'),['check.rs','-o','check']);
  assert.equal(build.error,undefined); assert.equal(build.status,0,build.stderr);
  const rust=execute(join(directory,'check'),[]);
  assert.equal(rust.error,undefined);assert.equal(rust.status,1);
  const rustVersion=execute(args.get('--rustc'),['--version']).stdout.trim();
  const rustRun=collectRustAcceptance(rust.stdout,{...options,frameworkVersion:rustVersion});
  assert(rustRun.completed);assert.deepEqual(rustRun.diagnostics,[]);
  for(const [id,status,kind] of [['green','PASS','none'],['red','FAIL','assertion-failed'],['panic','UNKNOWN','infrastructure-error']]){
    const result=rustRun.results.find(r=>r.checkId===id);
    assert.equal(result?.status,status);assert.equal(result?.failureClass,kind);
  }
  results.rust={version:rustVersion,run:rustRun};
  if(args.has('--out'))writeFileSync(args.get('--out'),JSON.stringify(results,null,2)+'\n',{mode:0o600});
  console.log('pytest and Rust: real PASS/assertion red/infrastructure UNKNOWN probes passed.');
}finally{rmSync(directory,{recursive:true,force:true});}
