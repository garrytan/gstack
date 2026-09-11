import { resolveRuntimeStateRoot } from '../../lib/canonical-state-root';
import { inspectCanaryWindow } from '../../lib/lane-canary';
import { ECPE_PILOT_LANES, readMilestoneBlock } from '../../lib/milestone-block';
import { resolveRegisteredProjectLocation } from '../../lib/project-identity';
import { resolveTrustedWorkProfile } from '../../lib/trusted-base';
import type { Lane } from '../../lib/work-profile';

function fail(message:string,code=2):never{console.error(JSON.stringify({error:message}));process.exit(code)}

const argv=process.argv.slice(2);
if(argv.shift()!=='inspect')fail('lane_canary_arguments_invalid');
const values=new Map<string,string>();let json=false;
while(argv.length){
  const flag=argv.shift()!;
  if(flag==='--json'){if(json)fail('lane_canary_arguments_invalid');json=true;continue}
  const value=argv.shift();
  if(!['--block-id','--participant','--lane'].includes(flag)||!value||value.startsWith('--')||values.has(flag))fail('lane_canary_arguments_invalid');
  values.set(flag,value);
}
const blockId=values.get('--block-id');const lane=values.get('--lane') as Lane;
if(!json||!blockId||!/^block-[0-9a-f]{32}$/.test(blockId)||values.get('--participant')!=='portfolioops'||!ECPE_PILOT_LANES.includes(lane))fail('lane_canary_arguments_invalid');
try{
  const stateRoot=resolveRuntimeStateRoot().root;
  const block=readMilestoneBlock(stateRoot,blockId);
  if(!block.participants.includes('portfolioops')||!block.lanes.includes(lane)||!['active','closing_evaluation'].includes(block.phase))throw new Error('lane_canary_block_invalid');
  const portfolio=resolveRegisteredProjectLocation('portfolioops',process.cwd());
  const profile=resolveTrustedWorkProfile({cwd:portfolio.root,lane,safetyStateRoot:stateRoot});
  const profileHash=profile.effective?.semantic_policy_hash;
  if(!profileHash||profile.lane_activation!=='enforce')throw new Error('lane_canary_lineage_invalid');
  console.log(JSON.stringify(inspectCanaryWindow({stateRoot,repoId:portfolio.identity.repo_id,lane,profileHash})));
}catch(error){fail(error instanceof Error?error.message:'lane_canary_inspect_failed',1)}
