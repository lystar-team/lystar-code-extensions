// 只计算实际变更、位置映射和取材范围，不判断业务规则。
export const CONTEXT_LIMIT=24000;
const lines=text=>text===''?[]:text.split('\n');

function anchoredMatches(a,b){
  // 算法工作量用尽时，按相同位置或递增公共锚点分区，仍生成可重建原文的编辑记录。
  if(a.length===b.length){
    const pairs=[];for(let i=0;i<a.length;i++)if(a[i]===b[i])pairs.push({oldIndex:i,newIndex:i});
    if(pairs.length)return {pairs,limited:false};
  }
  const positions=new Map();
  for(let j=0;j<b.length;j++){let list=positions.get(b[j]);if(!list)positions.set(b[j],list=[]);list.push(j);}
  const pairs=[];let cursor=0;
  for(let i=0;i<a.length;i++){
    const list=positions.get(a[i]);if(!list)continue;
    let low=0,high=list.length;
    while(low<high){const mid=(low+high)>>1;if(list[mid]<cursor)low=mid+1;else high=mid;}
    if(low<list.length){pairs.push({oldIndex:i,newIndex:list[low]});cursor=list[low]+1;}
  }
  return {pairs,limited:false};
}
function matches(a,b){
  if(!a.length||!b.length)return {pairs:[],limited:false};
  const values=new Set(b);if(!a.some(x=>values.has(x)))return {pairs:[],limited:false};
  let v=new Map([[1,0]]),work=0;const trace=[];
  for(let d=0;d<=a.length+b.length;d++){
    if(d>1024)return anchoredMatches(a,b);
    trace.push(new Map(v));const next=new Map();
    for(let k=-d;k<=d;k+=2){
      if(++work>2000000)return anchoredMatches(a,b);
      let x=k===-d||k!==d&&(v.get(k-1)??-1)<(v.get(k+1)??-1)?v.get(k+1)??0:(v.get(k-1)??0)+1,y=x-k;
      while(x<a.length&&y<b.length&&a[x]===b[y]){x++;y++;if(++work>2000000)return anchoredMatches(a,b);}
      next.set(k,x);
      if(x>=a.length&&y>=b.length){
        const pairs=[];x=a.length;y=b.length;
        for(let depth=d;depth>0;depth--){
          const previous=trace[depth],diagonal=x-y;
          const prevK=diagonal===-depth||diagonal!==depth&&(previous.get(diagonal-1)??-1)<(previous.get(diagonal+1)??-1)?diagonal+1:diagonal-1;
          const prevX=previous.get(prevK)??0,prevY=prevX-prevK;
          while(x>prevX&&y>prevY){pairs.push({oldIndex:--x,newIndex:--y});}
          x=prevX;y=prevY;
        }
        while(x>0&&y>0)pairs.push({oldIndex:--x,newIndex:--y});
        return {pairs:pairs.reverse(),limited:false};
      }
    }
    v=next;
  }
  return anchoredMatches(a,b);
}
export function lineEdits(before,after){
  if(before===after)return {edits:[],limited:false};
  const a=lines(before),b=lines(after);let prefix=0,suffix=0;
  while(prefix<a.length&&prefix<b.length&&a[prefix]===b[prefix])prefix++;
  while(suffix<a.length-prefix&&suffix<b.length-prefix&&a[a.length-1-suffix]===b[b.length-1-suffix])suffix++;
  const middleA=a.slice(prefix,a.length-suffix),middleB=b.slice(prefix,b.length-suffix),found=matches(middleA,middleB);
  if(middleA.length===middleB.length){
    const aligned=[];for(let i=0;i<middleA.length;i++)if(middleA[i]===middleB[i])aligned.push({oldIndex:i,newIndex:i});
    if(aligned.length>=found.pairs.length)found.pairs=aligned;
  }
  const points=[{oldIndex:-1,newIndex:-1},...found.pairs,{oldIndex:middleA.length,newIndex:middleB.length}],edits=[];
  for(let i=1;i<points.length;i++){
    const p=points[i-1],q=points[i];if(q.oldIndex===p.oldIndex+1&&q.newIndex===p.newIndex+1)continue;
    edits.push({oldStart:prefix+p.oldIndex+1,oldEnd:prefix+q.oldIndex,newStart:prefix+p.newIndex+1,newEnd:prefix+q.newIndex,beforeLines:middleA.slice(p.oldIndex+1,q.oldIndex),afterLines:middleB.slice(p.newIndex+1,q.newIndex)});
  }
  return {edits,limited:false};
}
export function diffHunks(before,after,context=6){
  const diff=lineEdits(before,after),b=lines(after);
  return {limited:diff.limited,hunks:diff.edits.map(e=>{
    const start=Math.max(0,e.newStart-context),end=Math.min(b.length,e.newEnd+context);
    return {startLine:start+1,endLine:end,changedStartLine:e.newStart+1,changedEndLine:e.newEnd,beforeStartLine:e.oldStart+1,beforeEndLine:e.oldEnd,before:e.beforeLines.join('\n'),changedAfter:e.afterLines.join('\n'),after:b.slice(start,end).map((line,i)=>`${start+i+1}| ${line}`).join('\n')};
  })};
}
function intersects(aStart,aEnd,bStart,bEnd){
  if(aStart===aEnd&&bStart===bEnd)return aStart===bStart;
  if(aStart===aEnd)return aStart>bStart&&aStart<bEnd;
  if(bStart===bEnd)return bStart>aStart&&bStart<aEnd;
  return aStart<bEnd&&bStart<aEnd;
}
export function rebaseOwned(before,ownedAfter,current,forced=[]){
  if(ownedAfter===current&&!forced.length)return {before,after:current,conflicts:[],limited:false};
  const ours=lineEdits(before,ownedAfter),external=lineEdits(ownedAfter,current);
  const map=(pos,end=false)=>{
    let delta=0;
    for(const e of external.edits){
      if(e.oldEnd<pos||e.oldEnd===pos&&(e.oldStart<e.oldEnd||!end))delta+=(e.newEnd-e.newStart)-(e.oldEnd-e.oldStart);
      else if(e.oldStart<pos&&pos<e.oldEnd)return end?e.newEnd:e.newStart;
    }
    return pos+delta;
  };
  const mapped=[],conflicts=[];let adoptable=true;
  for(const own of ours.edits){
    const overlapping=external.edits.filter(e=>intersects(e.oldStart,e.oldEnd,own.newStart,own.newEnd));
    const forcedOverlap=forced.some(e=>intersects(e.startLine-1,e.endLine,own.newStart,own.newEnd));
    let start=map(own.newStart),end=map(own.newEnd,true);
    if(overlapping.length){start=Math.min(start,...overlapping.map(e=>e.newStart));end=Math.max(end,...overlapping.map(e=>e.newEnd));}
    const conflict=overlapping.length>0||forcedOverlap;
    if(conflict){conflicts.push({startLine:start+1,endLine:end});if(overlapping.some(e=>e.oldStart<own.newStart||e.oldEnd>own.newEnd))adoptable=false;}
    mapped.push({...own,currentStart:start,currentEnd:end,conflict});
  }
  const build=includeConflicts=>{
    const base=lines(current);
    for(const own of [...mapped].sort((a,b)=>b.currentStart-a.currentStart))if(includeConflicts||!own.conflict)base.splice(own.currentStart,own.currentEnd-own.currentStart,...own.beforeLines);
    return base.join('\n');
  };
  if(conflicts.length)return {before,after:current,conflicts,limited:false,recovery:{preservedBefore:build(false),resolvedBefore:adoptable?build(true):undefined,adoptable}};
  return {before:build(true),after:current,conflicts:[],limited:false};
}

export function textFragments(text,startLine=1,limit=6000){
  const pieces=[];let offset=0,line=startLine,column=1;
  while(offset<text.length){
    let end=Math.min(text.length,offset+limit);
    if(end<text.length){
      const newline=text.lastIndexOf('\n',end-1);
      if(newline>=offset+Math.floor(limit/2))end=newline+1;
      if(/[\uD800-\uDBFF]/.test(text[end-1])&&/[\uDC00-\uDFFF]/.test(text[end]))end--;
    }
    let rowCount=0;
    for(let index=offset;index<end;index++)if(text[index]==='\n'&&++rowCount===256){end=index+1;break;}
    const value=text.slice(offset,end),rows=value.split('\n');
    const endLine=line+rows.length-1,endColumn=rows.length===1?column+value.length:rows.at(-1).length+1;
    pieces.push({text:value,startLine:line,startColumn:column,endLine,endColumn,startOffset:offset,endOffset:end});
    line=endLine;column=endColumn;offset=end;
  }
  return pieces;
}
export function numberedFragment(fragment){
  return fragment.text.split('\n').map((row,i)=>`${fragment.startLine+i}${i===0&&fragment.startColumn>1?':'+fragment.startColumn:''}| ${row}`).join('\n');
}
function coordinates(fragment){
  if(!fragment)return undefined;
  const {text,...position}=fragment;return position;
}
function inputFrom(change,version,hunks,limited){
  const b=change.after.split('\n'),ranges=hunks.map(h=>({startLine:h.changedStartLine,endLine:h.changedEndLine}));
  const windows=[];
  for(const h of hunks){
    const last=windows.at(-1);if(last&&h.startLine<=last.endLine+1)last.endLine=Math.max(last.endLine,h.endLine);else windows.push({startLine:h.startLine,endLine:h.endLine});
  }
  const sliced=hunks.some(h=>h.fragment),fragments=sliced?hunks.map(h=>({before:coordinates(h.fragment?.before),after:coordinates(h.fragment?.after)})):undefined;
  let clipped=false;
  const contextFor=background=>{
    if(sliced)return hunks.map(h=>{
      if(h.fragment?.after){
        const {leading,trailing}=h.fragment;
        return (leading?`[前片只读上下文] ${leading}\n`:'')+numberedFragment(h.fragment.after)+(trailing?`\n[后片只读上下文] ${trailing}`:'');
      }
      const line=Math.min(b.length,Math.max(1,h.changedStartLine));
      return `${h.changedStartLine}| [删除位置；只读相邻行 ${line}]\n${line}| ${(b[line-1]??'').slice(0,256)}`;
    }).join('\n');
    const selected=new Map();
    for(const w of windows)for(let line=w.startLine;line<=w.endLine;line++){
      const changed=ranges.some(r=>line>=r.startLine&&line<=r.endLine);
      if(!changed&&!background)continue;
      let text=b[line-1]??'';
      if(!changed&&text.length>512){text=text.slice(0,256)+' [只读上下文中部省略] '+text.slice(-256);clipped=true;}
      selected.set(line,`${line}| ${text}`);
    }
    return [...selected.values()].join('\n');
  };
  let context=contextFor(true);
  if(context.length>CONTEXT_LIMIT){clipped=true;context=contextFor(false);}
  const old=hunks.map(h=>h.before).join('\n'),after=hunks.map(h=>h.changedAfter).join('\n');
  return {change:{path:change.path,before:old,after,ranges,...(fragments?{fragments}:{})},candidate_context:context,candidate:{version,lineCount:b.length,visibleRanges:windows,partialLines:sliced,contextComplete:!sliced&&!clipped&&windows.length===1&&windows[0].startLine===1&&windows[0].endLine===b.length},coverageComplete:!limited&&context.length<=CONTEXT_LIMIT&&old.length<=CONTEXT_LIMIT&&after.length<=CONTEXT_LIMIT};
}
export function candidateInput(change,version){const diff=change.hunks?{hunks:change.hunks,limited:!!change.limited}:diffHunks(change.before,change.after);return inputFrom(change,version,diff.hunks,diff.limited);}
export function partitionChange(change,limit=CONTEXT_LIMIT,withinBudget){
  const diff=change.hunks?{hunks:change.hunks}:diffHunks(change.before,change.after),parts=[];let group=[];
  const fits=hunks=>{const input=inputFrom(change,'size-check',hunks,false);return input.coverageComplete&&Math.max(input.candidate_context.length,input.change.before.length,input.change.after.length)<=limit&&(!withinBudget||withinBudget(input));};
  for(const h of diff.hunks){
    if(group.length&&!fits([...group,h])){parts.push({...change,hunks:group});group=[];}
    if(!fits([h])){
      let size=Math.max(64,Math.floor(limit/3)),slices;
      while(true){
        const old=textFragments(h.before,h.beforeStartLine,size),after=textFragments(h.changedAfter,h.changedStartLine,size);slices=[];
        for(let i=0;i<Math.max(old.length,after.length);i++){
          const previous=old[i],current=after[i],start=current?.startLine??h.changedEndLine+1,end=current?current.endLine-(current.endColumn===1?1:0):start-1;
          slices.push({...change,hunks:[{...h,startLine:start,endLine:Math.max(start,end),changedStartLine:start,changedEndLine:Math.max(start-1,end),before:previous?.text??'',changedAfter:current?.text??'',fragment:{before:previous,after:current,leading:current?h.changedAfter.slice(Math.max(0,current.startOffset-256),current.startOffset):'',trailing:current?h.changedAfter.slice(current.endOffset,current.endOffset+256):''}}]});
        }
        if(slices.every(part=>fits(part.hunks)))break;
        if(size<=64)throw new Error('任务、规则或单项元数据超出请求预算，无法继续拆分源码');
        size=Math.max(64,Math.floor(size/2));
      }
      parts.push(...slices);
    }else group.push(h);
  }
  if(group.length)parts.push({...change,hunks:group});
  return parts.length?parts:[change];
}
