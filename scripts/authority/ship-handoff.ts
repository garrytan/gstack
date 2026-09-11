import { resolveRuntimeStateRoot } from '../../lib/canonical-state-root';
import { appendShipHandoff, inspectCurrentShipHandoff } from '../../lib/ship-handoff';
import type { Lane } from '../../lib/work-profile';

function fail(message:string,code=2):never{console.error(JSON.stringify({error:message}));process.exit(code)}

const argv=process.argv.slice(2);
const operation=argv.shift();
if(!['create','inspect'].includes(operation??''))fail('ship_handoff_command_invalid');
if(operation==='create'){
  const releaseFlags=argv.filter(value=>value==='--release-requested');
  if(releaseFlags.length>1)fail('ship_handoff_arguments_invalid');
  const releaseRequested=releaseFlags.length===1;
  const args=argv.filter(value=>value!=='--release-requested');
  const createValues=new Map<string,string>();
  while(args.length){const flag=args.shift()!,value=args.shift();if(!['--stage','--pr','--assert-target-ref','--lane','--assert-milestone-block'].includes(flag)||!value||value.startsWith('--')||createValues.has(flag))fail('ship_handoff_arguments_invalid');createValues.set(flag,value)}
  const pr=createValues.get('--pr');const lane=(createValues.get('--lane')??'single_repo_code') as Lane|'auto';const blockId=createValues.get('--assert-milestone-block');
  if(createValues.get('--stage')!=='ship'||!pr||!/^[1-9][0-9]*$/.test(pr)||!createValues.get('--assert-target-ref')||!['auto','docs_ux','single_repo_code','cross_repo_contract'].includes(lane)||(blockId&&!/^block-[0-9a-f]{32}$/.test(blockId)))fail('ship_handoff_arguments_invalid');
  try{console.log(JSON.stringify(await appendShipHandoff({cwd:process.cwd(),pr:Number(pr),assertTargetRef:createValues.get('--assert-target-ref')!,lane,blockId,releaseRequested})));process.exit(0)}catch(error){fail(error instanceof Error?error.message:'ship_handoff_create_failed',1)}
}
const values=new Map<string,string>();let json=false;
while(argv.length){
  const flag=argv.shift()!;
  if(flag==='--json'){if(json)fail('ship_handoff_arguments_invalid');json=true;continue}
  const value=argv.shift();
  if(!['--stage','--pr','--remote-pr-head','--assert-target-ref','--expected-base'].includes(flag)||!value||value.startsWith('--')||values.has(flag))fail('ship_handoff_arguments_invalid');
  values.set(flag,value);
}
const pr=values.get('--pr');
if(!json||values.get('--stage')!=='ship'||!pr||!/^[1-9][0-9]*$/.test(pr)||!values.get('--remote-pr-head')||!values.get('--assert-target-ref')||!values.get('--expected-base'))fail('ship_handoff_arguments_invalid');
try{
  const state=resolveRuntimeStateRoot();
  const result=await inspectCurrentShipHandoff({cwd:process.cwd(),pr:Number(pr),remotePrHead:values.get('--remote-pr-head')!,assertTargetRef:values.get('--assert-target-ref')!,expectedBase:values.get('--expected-base')!,stateHome:state.root});
  console.log(JSON.stringify(result));process.exit(result.current?0:1);
}catch(error){fail(error instanceof Error?error.message:'ship_handoff_inspect_failed',1)}
