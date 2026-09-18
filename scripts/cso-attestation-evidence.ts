#!/usr/bin/env bun
/** Bind cryptographically verified `gh attestation verify --format json` output to reviewed statements. */
import * as fs from 'node:fs';
import { resolve } from 'node:path';
import { canonical, sha256 } from '../lib/cso/contracts';

const HASH=/^[a-f0-9]{64}$/,MAX_BYTES=4*1024*1024;

export function verifiedStatementSetDigest(value:unknown,predicateType:string,subjectSha256:string):string{
  if(!Array.isArray(value)||!value.length||typeof predicateType!=='string'||!/^https:\/\/[A-Za-z0-9./_-]+$/.test(predicateType)||!HASH.test(subjectSha256))throw new Error('INVALID_VERIFIED_ATTESTATION_SET');
  const statements:string[]=[];
  for(const item of value){
    if(!item||typeof item!=='object'||Array.isArray(item))throw new Error('INVALID_VERIFIED_ATTESTATION_SET');
    const result=(item as any).verificationResult,statement=result?.statement;
    if(!statement||typeof statement!=='object'||Array.isArray(statement)||statement.predicateType!==predicateType||!Array.isArray(statement.subject)||
      !statement.subject.some((subject:any)=>subject&&typeof subject==='object'&&subject.digest?.sha256===subjectSha256))throw new Error('VERIFIED_ATTESTATION_IDENTITY_MISMATCH');
    statements.push(canonical(statement));
  }
  statements.sort();return`sha256:${sha256(canonical(statements))}`;
}

if(import.meta.main){
  try{
    const args=process.argv.slice(2),command=args.shift(),file=args.shift(),predicate=args.shift(),subject=args.shift();
    if(command!=='digest'||!file||!predicate||!subject||args.length)throw new Error('Usage: cso-attestation-evidence digest VERIFIED.json PREDICATE SUBJECT_SHA256');
    const path=resolve(file),stat=fs.lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size<=0||stat.size>MAX_BYTES)throw new Error('UNSAFE_VERIFIED_ATTESTATION_FILE');
    process.stdout.write(verifiedStatementSetDigest(JSON.parse(fs.readFileSync(path,'utf8')),predicate,subject)+'\n');
  }catch(error){process.stderr.write((error instanceof Error?error.message:'ATTESTATION_EVIDENCE_ERROR')+'\n');process.exitCode=1;}
}
