import { describe, expect, test } from 'bun:test';
import { GROUP_LIMITS, ROLE_LIMITS, type Role } from '../lib/cso/admission';
import { CONTAINER_SHM_BYTES, writableAllocation } from '../lib/cso/docker';

describe('CSO Docker writable-storage policy',()=>{
  test('every default role includes the explicitly bounded shm allocation',()=>{
    for(const role of Object.keys(ROLE_LIMITS) as Role[]){
      const allocation=writableAllocation(role);
      expect(allocation.shmBytes).toBe(CONTAINER_SHM_BYTES);
      expect(allocation.totalBytes).toBe(ROLE_LIMITS[role].writableMiB*1024*1024);
      expect(allocation.temporaryBytes).toBeGreaterThan(0);
      expect(allocation.workBytes).toBeGreaterThan(0);
    }
  });

  test('the Rails PostgreSQL group stays within two GiB including every shm mount',()=>{
    const roles:Role[]=['anchor','postgres','app','verifier'];
    const bytes=roles.reduce((sum,role)=>sum+writableAllocation(role).totalBytes,0);
    expect(bytes).toBe(GROUP_LIMITS.writableMiB*1024*1024);
  });

  test('dependency acquisition accounts for metadata, archives, and shm together',()=>{
    const mib=1024*1024,allocation=writableAllocation('app',{
      temporaryTmpfsBytes:64*mib,workTmpfsBytes:64*mib,metadataTmpfsBytes:1024*mib,archiveTmpfsBytes:384*mib,
    });
    expect(allocation.totalBytes).toBe((64+64+1024+384)*mib+CONTAINER_SHM_BYTES);
    expect(writableAllocation('anchor').totalBytes+allocation.totalBytes).toBeLessThan(GROUP_LIMITS.writableMiB*mib);
  });
});
