/** Decode the two Git path tokens in a `diff --git` header. */
function token(source:string,offset:number):{value:string;next:number}|undefined{
  if(source[offset]!=='"'){
    const end=source.indexOf(' ',offset),next=end<0?source.length:end;
    if(next===offset)return;
    return{value:source.slice(offset,next),next};
  }
  const bytes:number[]=[];let at=offset+1;
  const append=(value:string)=>bytes.push(...new TextEncoder().encode(value));
  while(at<source.length){
    const value=source[at++];
    if(value==='"')return{value:new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(bytes)),next:at};
    if(value!=='\\'){append(value);continue;}
    if(at>=source.length)return;
    const escaped=source[at++],mapped:{[key:string]:string}={a:'\x07',b:'\b',f:'\f',n:'\n',r:'\r',t:'\t',v:'\v','\\':'\\','"':'"'};
    if(mapped[escaped]!==undefined){append(mapped[escaped]);continue;}
    if(/[0-7]/.test(escaped)&&/^[0-7]{2}/.test(source.slice(at,at+2))){bytes.push(Number.parseInt(escaped+source.slice(at,at+2),8));at+=2;continue;}
    return;
  }
}

export function gitDiffHeaderPaths(line:string):[string,string]|undefined{
  const prefix='diff --git ';if(!line.startsWith(prefix))return;
  try{
    const left=token(line,prefix.length);if(!left||line[left.next]!==' ')return;
    const right=token(line,left.next+1);if(!right||right.next!==line.length)return;
    return[left.value,right.value];
  }catch{return;}
}

/** Return only exact path hunks, keeping one commit preamble per matching commit. */
export function historyForPath(raw:string,path:string):string|undefined{
  const expected=new Set([`a/${path}`,`b/${path}`]),output:string[]=[],lines=raw.split('\n');
  let preamble:string[]=[],section:string[]|undefined,include=false,preambleEmitted=false;
  const flush=()=>{
    if(section&&include){if(!preambleEmitted){output.push(...preamble);preambleEmitted=true;}output.push(...section);}
    section=undefined;include=false;
  };
  for(const line of lines){
    if(line.startsWith('commit ')){flush();preamble=[line];preambleEmitted=false;continue;}
    if(line.startsWith('diff --git ')){
      flush();section=[line];const paths=gitDiffHeaderPaths(line);include=Boolean(paths&&(expected.has(paths[0])||expected.has(paths[1])));continue;
    }
    if(section)section.push(line);else preamble.push(line);
  }
  flush();
  while(output.at(-1)==='')output.pop();
  return output.length?output.join('\n'):undefined;
}
