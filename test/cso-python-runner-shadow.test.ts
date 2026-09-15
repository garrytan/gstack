import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { canonicalStartPlan, canonicalTestPlan, testExecutionPassed } from '../lib/cso/verification';

const python = process.platform === 'win32' ? undefined : Bun.which('python3');

function write(root:string, relative:string, body:string):void {
  const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,body);
}

test.skipIf(!python)('Python test runners are imported before the application root without breaking app imports',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cso-python-shadow-'));
  try{
    const venv=path.join(root,'venv'),created=spawnSync(python!,['-m','venv',venv],{encoding:'utf8',timeout:120_000});
    expect(created.status,created.stderr).toBe(0);
    const venvPython=path.join(venv,'bin','python'),located=spawnSync(venvPython,['-c','import sysconfig;print(sysconfig.get_paths()["purelib"])'],{encoding:'utf8',timeout:30_000});
    expect(located.status,located.stderr).toBe(0);
    const fakePytest=path.join(located.stdout.trim(),'pytest','__init__.py');
    fs.mkdirSync(path.dirname(fakePytest),{recursive:true});
    fs.writeFileSync(fakePytest,`def main(args):
 import pathlib
 from app import VALUE
 config=pathlib.Path('.pytest.ini').read_text()
 pathlib.Path('pytest-observation').write_text(repr([VALUE,args,config]))
 return 0
`);
    fs.writeFileSync(path.join(located.stdout.trim(),'hostile-startup.pth'),"import pathlib;pathlib.Path('pth-startup-ran').write_text('unsafe')\n");

    const pytestRoot=path.join(root,'pytest-project');fs.mkdirSync(pytestRoot);
    write(pytestRoot,'app.py','VALUE = 42\n');
    write(pytestRoot,'.pytest.ini','[pytest]\naddopts = -q\n');
    write(pytestRoot,'tests/test_app.py','from app import VALUE\ndef test_value(): assert VALUE == 42\n');
    const pytestBefore=canonicalTestPlan(pytestRoot,'python');
    write(pytestRoot,'pytest.py','raise RuntimeError("application shadow replaced trusted pytest")\n');
    const pytestAfter=canonicalTestPlan(pytestRoot,'python');
    expect(pytestAfter).toEqual(pytestBefore);
    const pytestCommand=pytestBefore.commands[0];
    expect(pytestCommand.executable).toBe('/work/.venv/bin/python');
    expect(pytestCommand.args.slice(0,3)).toEqual(['-I','-S','-c']);
    expect(pytestCommand.args[3]).toContain('import pytest;sys.path.insert');
    expect(pytestCommand.args.slice(4)).toEqual(['-q','--color=no','--','./tests/test_app.py']);
    const ranPytest=spawnSync(venvPython,pytestCommand.args,{cwd:pytestRoot,encoding:'utf8',timeout:30_000});
    expect(ranPytest.status,ranPytest.stderr).toBe(0);
    expect(fs.readFileSync(path.join(pytestRoot,'pytest-observation'),'utf8')).toContain("[42, ['-q', '--color=no', '--', './tests/test_app.py'], '[pytest]\\naddopts = -q\\n']");
    expect(fs.existsSync(path.join(pytestRoot,'pth-startup-ran'))).toBe(false);

    const unittestRoot=path.join(root,'unittest-project');fs.mkdirSync(unittestRoot);
    write(unittestRoot,'app.py','VALUE = 42\n');
    write(unittestRoot,'tests/test_app.py',`import unittest
from app import VALUE
class AppTest(unittest.TestCase):
 def test_value(self): self.assertEqual(VALUE, 42)
`);
    const unittestBefore=canonicalTestPlan(unittestRoot,'python');
    write(unittestRoot,'unittest.py','raise RuntimeError("application shadow replaced standard unittest")\n');
    const unittestAfter=canonicalTestPlan(unittestRoot,'python');
    expect(unittestAfter).toEqual(unittestBefore);
    const unittestCommand=unittestBefore.commands[0];
    expect(unittestCommand.executable).toBe('/work/.venv/bin/python');
    expect(unittestCommand.args.slice(0,3)).toEqual(['-I','-S','-c']);
    expect(unittestCommand.args[3]).toContain("import os,sys,unittest;sys.path.append");
    expect(unittestCommand.args.slice(4)).toEqual(['./tests/test_app.py']);
    const ranUnittest=spawnSync(venvPython,unittestCommand.args,{cwd:unittestRoot,encoding:'utf8',timeout:30_000}),output=ranUnittest.stdout+ranUnittest.stderr;
    expect(ranUnittest.status,output).toBe(0);
    expect(output).toContain('Ran 1 test');
    expect(testExecutionPassed(unittestCommand,ranUnittest.status??-1,output)).toBe(true);
    expect(fs.existsSync(path.join(unittestRoot,'pth-startup-ran'))).toBe(false);

    const fakeDjango=path.join(located.stdout.trim(),'django','__init__.py');fs.mkdirSync(path.dirname(fakeDjango),{recursive:true});fs.writeFileSync(fakeDjango,"ORIGIN = 'trusted-site-package'\n");
    const djangoRoot=path.join(root,'django-project');fs.mkdirSync(djangoRoot);write(djangoRoot,'requirements.txt',`Django==1.0.0 --hash=sha256:${'a'.repeat(64)}\n`);write(djangoRoot,'manage.py',"import pathlib,django\npathlib.Path('django-observation').write_text(django.ORIGIN)\n");
    const djangoCommand=canonicalStartPlan(djangoRoot,'python',3456).command;expect(djangoCommand.args.slice(0,3)).toEqual(['-I','-S','-c']);const ranDjango=spawnSync(venvPython,djangoCommand.args,{cwd:djangoRoot,encoding:'utf8',timeout:30_000});expect(ranDjango.status,ranDjango.stderr).toBe(0);expect(fs.readFileSync(path.join(djangoRoot,'django-observation'),'utf8')).toBe('trusted-site-package');expect(fs.existsSync(path.join(djangoRoot,'pth-startup-ran'))).toBe(false);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
