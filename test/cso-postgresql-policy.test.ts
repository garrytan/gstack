import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { validatePostgresDatabasePolicy } from '../lib/cso/docker';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
function policy(body:string,mode=0o444):string{const root=fs.mkdtempSync(path.join(os.tmpdir(),'cso-pg-policy-'));roots.push(root);const file=path.join(root,'databases');fs.writeFileSync(file,body,{mode});return file;}

describe('CSO PostgreSQL synthetic policy mount',()=>{
  test('requires fixed-user-readable immutable permissions without weakening private policies',()=>{
    expect(validatePostgresDatabasePolicy(policy('cso_primary\ncso_queue\n'))).toEqual(['cso_primary','cso_queue']);
    expect(()=>validatePostgresDatabasePolicy(policy('cso_primary\n',0o600))).toThrow('public-readable');
  });
  test('rejects malformed, duplicate, and overlong database identities',()=>{
    for(const body of ['cso_primary\ncso_primary\n','cso_bad-name\n',`cso_${'a'.repeat(49)}\n`,'cso_primary'])
      expect(()=>validatePostgresDatabasePolicy(policy(body))).toThrow();
  });
});
