import {expect,test} from 'bun:test';
import fs from 'node:fs';
import {autoplanPermissionProgressKey} from './helpers/autoplan-artifact-permission';
import type {NativePublicToolEvent} from './helpers/plan-count-transcript';
import capture from './fixtures/autoplan-overwrite-progress-ax.json';
const before=()=>structuredClone(capture.beforeEvents) as NativePublicToolEvent[];
const after=()=>structuredClone(capture.afterEvents) as NativePublicToolEvent[];

test('the acknowledged 92-line Write distinguishes the next identical overwrite footer',()=>{
  expect(capture.before.slice(-500)).toBe(capture.after.slice(-500));
  const oldKey=autoplanPermissionProgressKey(capture.before,before());
  const newKey=autoplanPermissionProgressKey(capture.after,after());
  expect(oldKey).toEndWith(':toolu_01RBorP8UERrbVheRiXSN1v4');
  expect(newKey).toEndWith(':toolu_01RPGbV4z5AAMcnzwD4qcx9p');
  expect(newKey).not.toBe(oldKey);
});

test('the same still-pending dialog has no new progress epoch',()=>{
  const events=before(),key=autoplanPermissionProgressKey(capture.before,events);
  expect(autoplanPermissionProgressKey(capture.after,events)).toBe(key);
  events.push(after()[2]!); // Published use alone has not completed.
  expect(autoplanPermissionProgressKey(capture.after,events)).toBe(key);
  events.push({...after()[3]!,isError:true});
  expect(autoplanPermissionProgressKey(capture.after,events)).toBe(key);
});

test('unrelated results and same-basename files in other directories do not advance the epoch',()=>{
  const key=autoplanPermissionProgressKey(capture.before,before());
  for(const mutate of [
    (events:NativePublicToolEvent[])=>{events[2]!.name='Read';},
    events=>{events[2]!.name='Bash';},
    events=>{events[2]!.input!.file_path=String(events[2]!.input!.file_path).replace('/ceo-plans/','/other-plans/');},
    events=>{events[2]!.input!.file_path=String(events[2]!.input!.file_path).replace('/ceo-plans/','/ceo-plans-sibling/');},
    events=>{events[3]!.isError=undefined;},
    events=>{events[3]!.toolUseId='unrelated-result';},
    events=>{events[3]!.timestamp='invalid';},
    events=>{events[3]!.timestamp='2026-09-11T02:00:00Z';},
  ]){const events=after();mutate(events);expect(autoplanPermissionProgressKey(capture.after,events)).toBe(key);}
});

test('missing path authority, mixed sessions and duplicate uses supply no matching progress',()=>{
  expect(autoplanPermissionProgressKey(capture.after,[])).toBeUndefined();
  expect(autoplanPermissionProgressKey(capture.after.replace('overwrite 2026-09-11-user-dashboard.md','overwrite other.md'),after())).toBeUndefined();
  expect(autoplanPermissionProgressKey(capture.after.replace('always allow access to','access to'),after())).toBeUndefined();
  const mixed=after();mixed[3]!.sessionId='other';expect(autoplanPermissionProgressKey(capture.after,mixed)).toBeUndefined();
  const duplicate=after();duplicate.splice(3,0,structuredClone(duplicate[2]!));
  expect(autoplanPermissionProgressKey(capture.after,duplicate)).toBe(autoplanPermissionProgressKey(capture.before,before()));
});

test('the actual generic permission branch preserves classification and waits for selection',async()=>{
  const source=fs.readFileSync(new URL('./skill-e2e-autoplan-chain.test.ts',import.meta.url),'utf8');
  const block=source.slice(source.indexOf('            const recentTail = visible.slice(-1500);'),source.indexOf('            // This new repository offers routing'));
  expect(block.match(/continue;/g)).toHaveLength(1);
  const sends:string[]=[];let release:(()=>void)|undefined;
  const select=async()=>{sends.push('selected');await new Promise<void>(r=>{release=r;});sends.push('confirmed');};
  const make=new Function('autoplanPermissionProgressKey','selectPtyNumberedOption','Bun',`
    let lastPermSig='',lastPermissionProgress='';
    return async(visible,publicTools,allowed=true)=>{
      const transcript={status:'ready'},session={};
      const isNumberedOptionListVisible=()=>allowed,isPermissionDialogVisible=()=>allowed;
      ${block.replace('continue;','return;')}
    };
  `);
  const step=make(autoplanPermissionProgressKey,select,{sleep:async()=>{}});
  const first=step(capture.before,before());await Promise.resolve();expect(sends).toEqual(['selected']);release!();await first;
  await step(capture.after,before());expect(sends).toEqual(['selected','confirmed']);
  await step(capture.after,after(),false);expect(sends).toHaveLength(2); // Existing AUQ/permission classification still decides.
  const next=step(capture.after,after());await Promise.resolve();expect(sends).toHaveLength(3);release!();await next;
  await step(capture.after,after());expect(sends).toEqual(['selected','confirmed','selected','confirmed']);
});
