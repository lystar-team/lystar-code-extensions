import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {textFragments} from './line-ranges.mjs';
import {basename} from 'node:path';

export const EVIDENCE_LIMIT=18000;
export function evidenceCurrent(entry,materials=[]){
  if(entry.revision){
    try{return createHash('sha256').update(readFileSync(entry.path)).digest('hex')===entry.revision;}catch{return false;}
  }
  const current=materials.find(e=>e.id===entry.id)||materials.find(e=>e.path===entry.path&&e.startLine===entry.startLine&&e.endLine===entry.endLine);
  return !current||String(current.text??current.content??'')===entry.originalText;
}
export function materialVersion(materials){
  return JSON.stringify(materials.map(e=>[e.id,e.path,e.startLine,e.endLine,e.revision??null,String(e.text??e.content??'')]));
}
function excerpts(text,budget,query,entry){
  if(text.length<=budget)return {text,complete:true,windows:[{start:0,end:text.length}]};
  const keywords=new Set(query.match(/[\p{L}\p{N}_./-]{3,}/gu)??[]);
  for(const phrase of query.match(/[\p{Script=Han}]{2,}/gu)??[]){
    if(phrase.length===2)keywords.add(phrase);
    else for(let i=0;i<phrase.length-2;i++)keywords.add(phrase.slice(i,i+3));
  }
  const escaped=[...new Set([entry.path,basename(entry.path)])].map(path=>path.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|');
  const requested=[...query.matchAll(new RegExp('(?:'+escaped+'):(\\d+)(?:-(\\d+))?','g'))].map(match=>({start:Number(match[1]),end:Number(match[2]??match[1])}));
  const chunks=textFragments(text,entry.startLine??1,Math.max(128,Math.min(3000,Math.floor(budget/2))));
  const terms=[...keywords];
  const ranked=chunks.map((chunk,index)=>({chunk,index,requested:requested.some(r=>chunk.startLine<=r.end&&chunk.endLine>=r.start),score:terms.reduce((sum,term)=>sum+(chunk.text.includes(term)?1:0),0)})).sort((a,b)=>Number(b.requested)-Number(a.requested)||b.score-a.score||a.index-b.index);
  const chosen=[];let used=0;
  for(const {chunk} of ranked){
    const overhead=80;if(used+chunk.text.length+overhead>budget)continue;
    chosen.push(chunk);used+=chunk.text.length+overhead;
  }
  chosen.sort((a,b)=>a.startOffset-b.startOffset);
  return {text:chosen.map(c=>`[证据字符 ${c.startOffset+1}-${c.endOffset}]\n${c.text}`).join('\n'),complete:false,windows:chosen.map(c=>({start:c.startOffset,end:c.endOffset}))};
}
export function selectEvidence(materials,previous,{budget=EVIDENCE_LIMIT,query=''}={}){
  const referenced=new Set(previous?.result.review?.findings.flatMap(f=>f.evidenceRefs)??[]);
  const priorityPaths=new Set((previous?.selected??[]).filter(e=>referenced.has(e.id)).map(e=>e.path));
  const requirements=(previous?.pendingItems??[]).filter(i=>i.kind==='evidence').map(i=>i.requirement).join('\n');
  query+='\n'+requirements+'\n'+(previous?.result.review?.findings??[]).map(f=>[f.location,f.problem,f.suggestion].join(' ')).join('\n');
  const selected=[],omitted=[],stale=[],seenText=new Set();let used=0;
  const ranked=materials.map((entry,index)=>({entry,index})).sort((a,b)=>
    Number(priorityPaths.has(b.entry.path))-Number(priorityPaths.has(a.entry.path))||
    Number(query.includes(b.entry.path)||query.includes(basename(b.entry.path)))-Number(query.includes(a.entry.path)||query.includes(basename(a.entry.path)))||
    Number(!b.entry.path.startsWith('tool:'))-Number(!a.entry.path.startsWith('tool:'))||b.index-a.index);
  for(let position=0;position<ranked.length;position++){
    const {entry,index}=ranked[position];
    if(!evidenceCurrent(entry)){stale.push(entry.path);omitted.push({path:entry.path,reason:'source_changed'});continue;}
    const originalText=String(entry.text??entry.content??'');
    if(!originalText)continue;
    if(seenText.has(originalText)){omitted.push({path:entry.path,reason:'duplicate'});continue;}
    seenText.add(originalText);
    const available=Math.max(0,Math.min(budget-used,Math.max(1024,Math.floor((budget-used)/Math.max(1,ranked.length-position)))));
    if(available<128){omitted.push({path:entry.path,reason:'budget',startLine:entry.startLine,endLine:entry.endLine});continue;}
    const excerpt=excerpts(originalText,available,query,entry);used+=excerpt.text.length;
    if(!excerpt.text){omitted.push({path:entry.path,reason:'budget'});continue;}
    selected.push({...entry,id:entry.id||`E${index+1}`,text:excerpt.text,originalText,sourceComplete:excerpt.complete,excerptWindows:excerpt.windows});
    if(!excerpt.complete)omitted.push({path:entry.path,reason:'partial',startLine:entry.startLine,endLine:entry.endLine,sentChars:excerpt.text.length,totalChars:originalText.length});
  }
  return {selected,stale,omitted};
}
export function evidenceDependencies(selected,review){
  if(review?.verdict==='allow'||review?.verdict==='needs_evidence')return selected;
  const ids=new Set(review?.findings.flatMap(f=>f.evidenceRefs)??[]);
  return selected.filter(e=>ids.has(e.id));
}
export function evidencePayload(selected){
  return selected.map(({originalText,...entry})=>entry);
}
