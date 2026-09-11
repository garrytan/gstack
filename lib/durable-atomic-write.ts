import * as fs from 'node:fs';
import * as path from 'node:path';
import { acquireDurableOwnerLock, releaseDurableOwnerLock } from './durable-owner-lock';

export type DurableWritePhase='temporary_created'|'bytes_written'|'file_fsynced'|'renamed'|'directory_fsynced';

export interface DurableAtomicWriteOptions{mode?:number;directoryMode?:number;lockTarget?:string;fault?:(phase:DurableWritePhase)=>void;onPhase?:(phase:DurableWritePhase)=>void}
export interface DurableAtomicReadOptions<T>{mode?:number;decode:(bytes:Buffer)=>T;isTruncatedTemporary?:(error:unknown,bytes:Buffer)=>boolean}

function ownerUid():number{const uid=process.geteuid?.();if(!Number.isSafeInteger(uid)||uid!<0)throw new Error('durable_write_owner_invalid');return uid!}
function validateDirectory(directory:string,uid:number):void{const info=fs.lstatSync(directory);if(info.isSymbolicLink()||!info.isDirectory()||info.uid!==uid||(info.mode&0o022)!==0)throw new Error('durable_write_directory_invalid')}
function readOwnedRegular(file:string,uid:number,mode:number,errorCode:string):Buffer|null{
  let fd:number;
  try{fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0))}catch(error:any){if(error?.code==='ENOENT')return null;throw new Error(errorCode)}
  try{const info=fs.fstatSync(fd);if(!info.isFile()||info.uid!==uid||(info.mode&0o777)!==mode)throw new Error(errorCode);return fs.readFileSync(fd)}finally{fs.closeSync(fd)}
}
function syncDirectory(directory:string):void{const parent=fs.openSync(directory,'r');try{fs.fsyncSync(parent)}finally{fs.closeSync(parent)}}

export function readDurableAtomic<T>(target:string,options:DurableAtomicReadOptions<T>):T|null{
  const directory=path.dirname(target);const uid=ownerUid();validateDirectory(directory,uid);const mode=options.mode??0o600;const temporary=path.join(directory,`.${path.basename(target)}.durable.tmp`);const owned=acquireDurableOwnerLock(`${target}.durable-write`,'durable_write_busy');
  try{
    const targetBytes=readOwnedRegular(target,uid,mode,'durable_write_target_invalid');
    const targetValue=targetBytes===null?null:options.decode(targetBytes);
    const temporaryBytes=readOwnedRegular(temporary,uid,mode,'durable_write_temp_invalid');
    if(temporaryBytes===null)return targetValue;
    let temporaryValue:T;
    try{temporaryValue=options.decode(temporaryBytes)}catch(error){if(!options.isTruncatedTemporary?.(error,temporaryBytes))throw error;fs.unlinkSync(temporary);syncDirectory(directory);return targetValue}
    const fd=fs.openSync(temporary,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
    fs.renameSync(temporary,target);syncDirectory(directory);return temporaryValue;
  }finally{releaseDurableOwnerLock(owned)}
}

export function durableAtomicWrite(target:string,bytes:string|Uint8Array,options:DurableAtomicWriteOptions={}):void{
  const directory=path.dirname(target);fs.mkdirSync(directory,{recursive:true,mode:options.directoryMode??0o700});
  const uid=ownerUid();validateDirectory(directory,uid);
  const owned=acquireDurableOwnerLock(options.lockTarget??`${target}.durable-write`,'durable_write_busy');
  const observe=options.onPhase??options.fault??(()=>{});const desired=typeof bytes==='string'?Buffer.from(bytes):Buffer.from(bytes);const mode=options.mode??0o600;
  const temporary=path.join(directory,`.${path.basename(target)}.durable.tmp`);
  const syncParent=()=>syncDirectory(directory);
  try{
    readOwnedRegular(target,uid,mode,'durable_write_target_invalid');
    if(fs.existsSync(temporary)){
      const recovered=readOwnedRegular(temporary,uid,mode,'durable_write_temp_invalid')!;
      if(recovered.equals(desired)){
        const recoveredFd=fs.openSync(temporary,'r');try{fs.fsyncSync(recoveredFd)}finally{fs.closeSync(recoveredFd)}
        fs.renameSync(temporary,target);fs.chmodSync(target,mode);observe('renamed');syncParent();observe('directory_fsynced');return;
      }
      fs.unlinkSync(temporary);syncParent();
    }
    const fd=fs.openSync(temporary,'wx',mode);
    try{observe('temporary_created');fs.writeFileSync(fd,desired);observe('bytes_written');fs.fsyncSync(fd);observe('file_fsynced')}finally{fs.closeSync(fd)}
    fs.renameSync(temporary,target);fs.chmodSync(target,mode);observe('renamed');syncParent();observe('directory_fsynced');
  }finally{releaseDurableOwnerLock(owned)}
}
