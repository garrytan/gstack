import * as fs from 'node:fs';
import { CsoError } from './contracts';

/** Read one caller-supplied control file without following or blocking on a raced special file. */
export function readBoundedStable(path:string,max:number,label:string):Buffer{
  let named:fs.Stats,fd:number|undefined;try{named=fs.lstatSync(path);}catch{throw new CsoError('MISSING_INPUT',`${label} does not exist`);}
  if(named.isSymbolicLink()||!named.isFile()||named.nlink!==1||named.size>max)throw new CsoError('MISSING_INPUT',`${label} must be one bounded regular file`);
  try{
    fd=fs.openSync(path,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0)|(fs.constants.O_NONBLOCK??0));const opened=fs.fstatSync(fd);
    if(!opened.isFile()||opened.nlink!==1||opened.dev!==named.dev||opened.ino!==named.ino||opened.mode!==named.mode||opened.size!==named.size)throw new CsoError('SNAPSHOT_RACE',`${label} changed before it could be read`);
    const data=Buffer.alloc(max+1);let bytes=0,count=0;while(bytes<data.length&&(count=fs.readSync(fd,data,bytes,data.length-bytes,null))>0)bytes+=count;
    const after=fs.fstatSync(fd),current=fs.lstatSync(path);if(bytes>max)throw new CsoError('MISSING_INPUT',`${label} exceeds the ${max}-byte limit`);
    if(!current.isFile()||current.isSymbolicLink()||current.nlink!==1||current.dev!==opened.dev||current.ino!==opened.ino||current.mode!==opened.mode||after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||after.ctimeMs!==opened.ctimeMs)throw new CsoError('SNAPSHOT_RACE',`${label} changed while it was read`);
    return data.subarray(0,bytes);
  }catch(error){if(error instanceof CsoError)throw error;const code=(error as NodeJS.ErrnoException).code;if(['ELOOP','ENOENT','ENOTDIR','ENXIO'].includes(code??''))throw new CsoError('SNAPSHOT_RACE',`${label} changed before it could be opened`);throw new CsoError('MISSING_INPUT',`${label} is missing or unreadable`);}finally{if(fd!==undefined)fs.closeSync(fd);}
}
