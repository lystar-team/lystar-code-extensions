import {diffHunks,candidateInput,textFragments,numberedFragment} from './line-ranges.mjs';
export function sourceLocations(location){
 const match=/:([\d:,，、\s-]+)$/.exec(location??'');
 if(!match)return [];
 const positions=match[1].split(/[,，、]/).map(value=>{
   const point=/^\s*([1-9]\d*)(?::([1-9]\d*))?(?:-([1-9]\d*)(?::([1-9]\d*))?)?\s*$/.exec(value);
   if(!point)return undefined;
   const line=Number(point[1]),column=Number(point[2]??1),endLine=Number(point[3]??point[1]),endColumn=point[4]?Number(point[4]):undefined;
   if(![line,column,endLine,endColumn??1].every(Number.isSafeInteger)||endLine<line||endLine===line&&endColumn!==undefined&&endColumn<column)return undefined;
   return {line,column,endLine,endColumn,suffix:match[0]};
 });
 return positions.every(Boolean)?positions:[];
}
export function sourceLocation(location){
 const position=sourceLocations(location)[0];
 return position?{line:position.line,column:position.column,suffix:position.suffix}:undefined;
}
export function findingWithinRanges(location,ranges){
 const positions=sourceLocations(location);
 return positions.length>0&&positions.every(position=>ranges.some(range=>position.line>=range.startLine&&position.endLine<=Math.max(range.startLine,range.endLine)));
}
function candidateScope(change){
 if(change.fragments?.some(fragment=>fragment.after))return change.fragments.map(fragment=>fragment.after).filter(Boolean).map(({startLine,endLine,startColumn,endColumn})=>({startLine,endLine,startColumn,endColumn}));
 return change.ranges.map(range=>({...range}));
}
const states=new Set(['resolved','unresolved','needs_evidence']);
export const MAX_FIX_CONFIRMATIONS=2;

export function confirmationItems(previous){
 if(previous.pendingItems)return previous.pendingItems;
 const version=previous.result.candidateVersion;
 return [
   ...previous.result.review.findings.map((finding,i)=>({id:`${version}-finding-${i+1}`,kind:'finding',finding,...(!sourceLocations(finding.location).length&&previous.result.payload?{scope:candidateScope(previous.result.payload.change)}:{})})),
  ...previous.result.review.neededEvidence.map((requirement,i)=>({id:`${version}-evidence-${i+1}`,kind:'evidence',requirement}))
 ];
}

export function confirmationContext(previous,change,ranges){
 const delta=diffHunks(previous.after,change.after,0),oldRanges=previous.result.payload.change.ranges;
 if(delta.limited)throw new Error('无法定位修正行段，不能确认旧问题');
 const contains=(rs,start,end)=>rs.some(r=>start>=r.startLine&&Math.max(start,end)<=Math.max(r.startLine,r.endLine));
 const corrections=delta.hunks.filter(h=>contains(ranges,h.changedStartLine,h.changedEndLine)||contains(oldRanges,h.beforeStartLine,h.beforeEndLine)).map(h=>({startLine:h.changedStartLine,endLine:h.changedEndLine,before:h.before,after:h.changedAfter}));
 const mapLine=line=>{
  let shift=0;
  for(const h of delta.hunks){
   if(line<h.beforeStartLine)break;
    if(line<=h.beforeEndLine)return h.changedStartLine+Math.min(line-h.beforeStartLine,Math.max(0,h.changedEndLine-h.changedStartLine));
   shift+=(h.changedEndLine-h.changedStartLine)-(h.beforeEndLine-h.beforeStartLine);
  }
  return line+shift;
 };
 const rows=change.after===''?[]:change.after.split('\n'),oldRows=previous.after===''?[]:previous.after.split('\n'),itemContexts=new Map();
 const mapPosition=(line,column)=>{
   const currentLine=Math.max(1,Math.min(rows.length+1,mapLine(line)));
   const oldRow=oldRows[line-1]??'',newRow=rows[currentLine-1]??'';
   let prefix=0,suffix=0;
   while(prefix<oldRow.length&&prefix<newRow.length&&oldRow[prefix]===newRow[prefix])prefix++;
   while(suffix<oldRow.length-prefix&&suffix<newRow.length-prefix&&oldRow[oldRow.length-1-suffix]===newRow[newRow.length-1-suffix])suffix++;
   const mapped=column-1<=prefix?column:column-1>=oldRow.length-suffix?Math.max(1,column+newRow.length-oldRow.length):Math.min(column,newRow.length-suffix+1);
   return {line:currentLine,column:mapped};
 };
 const items=confirmationItems(previous).map(item=>{
   if(item.kind!=='finding')return item;
   const positions=sourceLocations(item.finding.location),context=new Set();
   const scope=positions.length?positions.map(position=>({startLine:position.line,endLine:position.endLine,startColumn:position.column,...(position.endColumn!==undefined?{endColumn:position.endColumn}:{})})):item.scope??candidateScope(previous.result.payload.change);
   const currentScope=scope.map(range=>{
     const start=mapPosition(range.startLine,range.startColumn??1);
     const end=range.endLine<range.startLine?start:mapPosition(range.endLine,range.endColumn??1);
     return {startLine:start.line,endLine:range.endLine<range.startLine?start.line-1:end.line,...(range.startColumn!==undefined?{startColumn:start.column}:{}),...(range.endColumn!==undefined?{endColumn:end.column}:{})};
   });
   if(!currentScope.length)throw new Error('原问题没有可回读的审查行段，需提供对应材料');
   for(const [index,range] of currentScope.entries()){
     const point=positions[index],singlePoint=point&&point.line===point.endLine&&point.endColumn===undefined;
     const start=Math.max(1,range.startLine-(singlePoint?3:0)),end=Math.min(rows.length,Math.max(range.startLine,range.endLine)+(singlePoint?3:0));
     if(range.endLine<range.startLine||range.startLine>rows.length){context.add(`${range.startLine}| [该位置已删除，当前为空隙]`);continue;}
     for(let line=start;line<=end;line++){
       const row=rows[line-1];let value=row,column=1;
       if(singlePoint){column=line===range.startLine?Math.max(1,(range.startColumn??1)-256):1;value=row.slice(column-1,column-1+1024);}
       else {column=line===range.startLine?range.startColumn??1:1;value=row.slice(column-1,line===range.endLine&&range.endColumn!==undefined?range.endColumn-1:undefined);}
       const fragments=textFragments(value,line,6000);
       if(!fragments.length)context.add(`${line}| `);
       for(const fragment of fragments)context.add(numberedFragment({...fragment,startColumn:fragment.startColumn+column-1}));
     }
   }
   itemContexts.set(item.id,[...context].join('\n'));
   const location=positions.length?item.finding.location.slice(0,-positions[0].suffix.length)+':'+currentScope.map((range,index)=>{
     const position=positions[index],start=range.startLine+(range.startColumn>1?':'+range.startColumn:'');
     return position.line!==position.endLine||position.endColumn!==undefined?start+'-'+Math.max(range.startLine,range.endLine)+(range.endColumn!==undefined?':'+range.endColumn:''):start;
   }).join(','):item.finding.location;
   return {...item,finding:{...item.finding,location},scope:currentScope,currentLine:currentScope[0].startLine};
 });
 const result={mode:items.length?'verify':'incremental',items,corrections,confirmation_context:[...new Set(itemContexts.values())].join('\n')};
 Object.defineProperty(result,'itemContexts',{value:itemContexts});return result;
}

function overlaps(correction,range){return correction.startLine<=Math.max(range.startLine,range.endLine)&&Math.max(correction.startLine,correction.endLine)>=range.startLine;}
function splitCorrections(corrections){
 const result=[];
 for(const original of corrections){
   let correction=original;
   if(JSON.stringify(correction).length>8000&&!correction.before.includes('\n')&&!correction.after.includes('\n')){
     let prefix=0,suffix=0;const {before,after}=correction;
     while(prefix<before.length&&prefix<after.length&&before[prefix]===after[prefix])prefix++;
     while(suffix<before.length-prefix&&suffix<after.length-prefix&&before[before.length-1-suffix]===after[after.length-1-suffix])suffix++;
     correction={...correction,before:before.slice(prefix,before.length-suffix),after:after.slice(prefix,after.length-suffix),startColumn:prefix+1,endColumn:after.length-suffix+1};
   }
   if(JSON.stringify(correction).length<=8000){result.push(correction);continue;}
   const old=textFragments(correction.before,correction.startLine,2000),after=textFragments(correction.after,correction.startLine,2000),shift=(correction.startColumn??1)-1;
   for(let i=0;i<Math.max(old.length,after.length);i++)result.push({startLine:after[i]?.startLine??correction.endLine+1,endLine:after[i]?.endLine??correction.endLine,before:old[i]?.text??'',after:after[i]?.text??'',startColumn:(after[i]?.startColumn??1)+shift,endColumn:(after[i]?.endColumn??1)+shift});
 }
 return result;
}
export function reviewPlan(previous,change,parts){
 if(!previous)return parts.map(part=>({part}));
 const allRanges=parts.flatMap(part=>candidateInput(part,'plan').change.ranges),context=confirmationContext(previous,change,allRanges);
 const assignments=new Map(parts.map(part=>[part,[]]));
 for(const item of context.items){
    const positions=item.kind==='finding'?sourceLocations(item.finding.location):[];
    const target=parts.find(part=>positions.some(position=>{
      const input=candidateInput(part,'position');
      if(!input.change.ranges.some(r=>position.line>=r.startLine&&position.line<=Math.max(r.startLine,r.endLine)))return false;
      return !input.change.fragments||input.change.fragments.some(f=>f.after&&position.line>=f.after.startLine&&position.line<=f.after.endLine&&(position.line!==f.after.startLine||position.column>=f.after.startColumn)&&(position.line!==f.after.endLine||position.column<f.after.endColumn));
    }))||parts[0];
   assignments.get(target).push(item);
 }
 const plan=[],allCorrections=splitCorrections(context.corrections),claimed=new Set();
 for(const part of parts){
   const input=candidateInput(part,'scope'),ranges=input.change.ranges,items=assignments.get(part);
   const corrections=allCorrections.filter(c=>{
     if(claimed.has(c))return false;
     const rangeMatch=ranges.some(r=>overlaps(c,r));
     const columnMatch=!input.change.fragments||input.change.fragments.some(f=>f.after&&c.startLine<=f.after.endLine&&c.endLine>=f.after.startLine&&(c.startLine!==c.endLine||f.after.startLine!==f.after.endLine||(c.startColumn??1)<f.after.endColumn&&(c.endColumn??Infinity)>f.after.startColumn));
      const restored=items.some(item=>item.scope?.some(range=>overlaps(c,range)))&&!rangeMatch;
     if(rangeMatch&&columnMatch||restored){claimed.add(c);return true;}return false;
   });
   const batches=[];let batch={items:[],corrections:[],confirmation_context:''};
   const flush=()=>{batches.push(batch);batch={items:[],corrections:[],confirmation_context:''};};
   for(const item of items){
     const text=context.itemContexts.get(item.id)??'';
     if(batch.items.length&&JSON.stringify({...batch,items:[...batch.items,item],confirmation_context:batch.confirmation_context+text}).length>12000)flush();
     batch.items.push(item);batch.confirmation_context+=(batch.confirmation_context?'\n':'')+text;
   }
   for(const correction of corrections){
     if((batch.items.length||batch.corrections.length)&&JSON.stringify({...batch,corrections:[...batch.corrections,correction]}).length>16000)flush();
     batch.corrections.push(correction);
   }
   if(batch.items.length||batch.corrections.length||!batches.length)flush();
   for(let i=0;i<batches.length;i++)plan.push({part,context:{mode:batches[i].items.length?'verify':'incremental',...batches[i]},batchKey:i});
 }
 return plan;
}
export function remainingItems(review,confirmation,priorItems,version,change){
 if(!confirmation)return confirmationItems({result:{review,candidateVersion:version,...(change?{payload:{change}}:{})}});
 const pending=priorItems.filter(item=>confirmation.checks.find(check=>check.id===item.id)?.state!=='resolved').map(item=>{
  const source=confirmation.findingSources.find(source=>source.checkId===item.id);
  return source?{...item,finding:review.findings[source.findingIndex]}:item;
 });
 for(const source of confirmation.findingSources.filter(source=>!source.checkId))pending.push({id:`${version}-finding-${source.findingIndex+1}`,kind:'finding',finding:review.findings[source.findingIndex],...(!sourceLocations(review.findings[source.findingIndex].location).length&&change?{scope:candidateScope(change)}:{})});
 for(const requirement of review.neededEvidence)if(!pending.some(item=>item.kind==='evidence'&&item.requirement===requirement))pending.push({id:`${version}-evidence-${pending.length+1}`,kind:'evidence',requirement});
 return pending;
}

export function validateConfirmation(raw,payload){
 const {checks,findingSources,...review}=raw;
 const context=payload.reviewContext,items=new Map(context.items.map(item=>[item.id,item]));
 if(!Array.isArray(checks)||checks.length!==items.size||new Set(checks.map(c=>c.id)).size!==items.size)throw new Error('修正确认未逐项覆盖已有问题，不能判通过');
 const checked=new Map();
 for(const check of checks){
  if(!items.has(check.id)||!states.has(check.state)||typeof check.reason!=='string'||!check.reason.trim()||!Array.isArray(check.evidenceRefs)||!check.evidenceRefs.length||check.evidenceRefs.some(id=>!payload.evidence.some(e=>e.id===id)))throw new Error('修正确认状态或依据无效');
  checked.set(check.id,check);
 }
 if(!Array.isArray(review.findings)||!Array.isArray(findingSources)||findingSources.length!==review.findings.length||new Set(findingSources.map(s=>s.findingIndex)).size!==review.findings.length)throw new Error('问题缺少已有问题或新增修改的归属依据');
 for(const source of findingSources){
  const finding=review.findings[source.findingIndex];
  if(!finding||!Number.isInteger(source.findingIndex))throw new Error('问题归属索引无效');
  if(source.checkId){
   const item=items.get(source.checkId),check=checked.get(source.checkId);
   if(item?.kind!=='finding'||check.state==='resolved'||finding.ruleId!==item.finding.ruleId||finding.problem!==item.finding.problem||finding.suggestion!==item.finding.suggestion||source.correctionIndex!==-1)throw new Error('已有问题的定义和修正标准不能改写，也不能把已解决项重新打开');
  }else{
     const correction=context.corrections[source.correctionIndex];
     if(!Number.isInteger(source.correctionIndex)||!correction||!findingWithinRanges(finding.location,[correction])||!findingWithinRanges(finding.location,payload.change.ranges)||typeof source.beforeSnippet!=='string'||typeof source.afterSnippet!=='string'||source.beforeSnippet===source.afterSnippet||typeof source.reason!=='string'||!source.reason.trim())throw new Error('新增问题必须对应本次修正行段及具体前后变化，不能另开旧问题');
   if((source.beforeSnippet? !correction.before.includes(source.beforeSnippet):correction.before!=='')||(source.afterSnippet?!correction.after.includes(source.afterSnippet):correction.after!==''))throw new Error('新增问题引用的修正前后文本不匹配');
  }
 }
 for(const item of items.values()){
  const check=checked.get(item.id);
  if(check.state==='unresolved'&&item.kind==='finding'&&!findingSources.some(source=>source.checkId===item.id))throw new Error('尚未解决的问题未列入反馈');
  if(check.state==='needs_evidence'||check.state==='unresolved'&&item.kind==='evidence'){
   if(review.verdict!=='needs_evidence'||!review.neededEvidence?.length)throw new Error('尚未确认的问题不能判为通过');
  }
 }
 if(review.verdict==='allow'&&checks.some(check=>check.state!=='resolved'))throw new Error('已有问题尚未全部确认解决，不能判通过');
 return {review,checks,findingSources};
}

export function deliveryDecision(results){
 if(!results.length)return {state:'no_changes',canFinish:true,shouldStop:true,nextAction:'finish',reason:'本轮没有文件写入记录，不声明检查通过'};
 if(results.every(r=>r.status==='checked'&&r.review?.verdict==='allow'))return {state:'passed',canFinish:true,shouldStop:true,nextAction:'finish',reason:'本轮所有候选均通过；已有问题已确认解决，可以结束，不再重复检查'};
 if(results.some(r=>r.stopRequested))return {state:'stalled',canFinish:false,shouldStop:true,nextAction:'report_remaining',reason:'复核未收敛或确认依据无效；停止自动修改并报告未完成项，不能判通过'};
 if(results.some(r=>r.recovery))return {state:'conflict',canFinish:false,shouldStop:false,nextAction:'read_and_merge',reason:'回读本轮重叠行段并核对或合并，再检查'};
 if(results.some(r=>r.status!=='checked'))return {state:'unverified',canFinish:false,shouldStop:true,nextAction:'report_unchecked',reason:'存在未完成检查，停止反复请求并报告具体原因，不能判通过'};
 if(results.some(r=>r.review?.verdict==='needs_evidence'))return {state:'needs_evidence',canFinish:false,shouldStop:false,nextAction:'supply_requested_evidence',reason:'仅补齐已列出的决定性证据，再确认已有问题'};
 return {state:'needs_fix',canFinish:false,shouldStop:false,nextAction:'fix_reported_items',reason:'只修正已列出的确定问题，再逐项确认；不扩大审查目标'};
}
