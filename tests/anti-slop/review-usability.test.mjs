import './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createReviewController,deliveryDecision,decodeSource,validateReview} from '../../extensions/lystar-jev-anti-slop/anti-slop.mjs';
import {partitionChange,candidateInput,CONTEXT_LIMIT,lineEdits} from '../../extensions/lystar-jev-anti-slop/line-ranges.mjs';
import {selectEvidence} from '../../extensions/lystar-jev-anti-slop/review-evidence.mjs';
import {requestEnvelopeChars,REQUEST_LIMIT} from '../../extensions/lystar-jev-anti-slop/review-client.mjs';

const allow=()=>({verdict:'allow',findings:[],neededEvidence:[],patches:[]});
const issue=(path,line=1,column)=>({ruleId:'business-dictionary-single-source',location:path+':'+line+(column?':'+column:''),problem:'候选与本轮约定不符',suggestion:'按本轮约定修改',evidenceRefs:['CANDIDATE']});
function confirmed(p){return {...allow(),checks:p.reviewContext.items.map(item=>({id:item.id,state:'resolved',reason:'本次提供的最新内容已符合原要求',evidenceRefs:['CANDIDATE']})),findingSources:[]};}
function fixture(t,ask){
 const cwd=mkdtempSync(join(tmpdir(),'slop-usability-')),path=join(cwd,'candidate.unknown'),ctx={cwd,reviewLogPath:join(cwd,'review.jsonl')},seen=[];
 t.after(()=>rmSync(cwd,{recursive:true,force:true}));
 const c=createReviewController({}, {ask:async(p,config)=>{seen.push(p);assert.ok(requestEnvelopeChars(p,config)<=REQUEST_LIMIT);return {review:ask?await ask(p,seen.length):allow(),metrics:{simulation:true}};}});
 return {c,cwd,path,ctx,seen,write(after){let before='';try{before=readFileSync(path,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}writeFileSync(path,after);c.written(path,before,after,{status:'pending'});},audit(){return c.finalAudit(ctx);}};
}

for(const [name,before,after] of [
 ['连续新增','',Array.from({length:800},(_,i)=>'line '+i+': '+'text '.repeat(10)).join('\n')],
 ['连续替换','甲'.repeat(50000),'乙'.repeat(40000)],
 ['大段删除','旧'.repeat(42000),''],
 ['长行与Unicode','',('客户🌟费用编号'.repeat(6000))],
 ['大量短行','',('\n'.repeat(7000))]
])test(name+'的分片逐字符覆盖修改前后文本',()=>{
 const parts=partitionChange({path:'source',before,after}),inputs=parts.map(p=>candidateInput(p,'v'));
 assert.ok(parts.length>1);assert.ok(inputs.every(p=>p.coverageComplete));
 assert.equal(inputs.map(p=>p.change.before).join(''),before);assert.equal(inputs.map(p=>p.change.after).join(''),after);
 for(const p of inputs){assert.ok(p.candidate_context.length<=CONTEXT_LIMIT);if(p.change.after)assert.equal(/[\uD800-\uDBFF]$/.test(p.change.after),false);}
});

test('只改3个字符，邻近长行只作为有限上下文',async t=>{
 const f=fixture(t),before='x'.repeat(25000)+'\nold';writeFileSync(f.path,before);f.write('x'.repeat(25000)+'\nnew');
 assert.equal(deliveryDecision(await f.audit()).canFinish,true);assert.equal(f.seen.length,1);
 assert.equal(f.seen[0].change.before,'old');assert.equal(f.seen[0].change.after,'new');assert.ok(f.seen[0].candidate_context.length<1000);
});

test('文本内容与后缀无关，二进制和解码失败另行报告',()=>{
 assert.equal(decodeSource(Buffer.from('中文\nnormal text')),'中文\nnormal text');
 assert.equal(decodeSource(Buffer.from([0xff,0xfe,0,1])),undefined);assert.equal(decodeSource(Buffer.from('a\u0000b')),undefined);
});

test('转义后的完整请求超过预算时继续拆分',async t=>{
 const f=fixture(t);writeFileSync(f.path,'\\'.repeat(23000));f.write('"'.repeat(23000));
 const results=await f.audit();assert.equal(deliveryDecision(results).canFinish,true);assert.ok(f.seen.length>1);
 assert.equal(f.seen.map(p=>p.change.before).join(''),'\\'.repeat(23000));assert.equal(f.seen.map(p=>p.change.after).join(''),'"'.repeat(23000));
});

test('一个分片请求失败不会被其他分片的通过覆盖，内容改变只重查受影响分片',async t=>{
 let fail=true;const f=fixture(t,(_p,count)=>{if(fail&&count===2)throw Object.assign(new Error('本次模拟请求失败'),{metrics:{failureReason:'timeout'}});return allow();});
 f.write('a'.repeat(40000));const first=await f.audit();assert.equal(deliveryDecision(first).canFinish,false);
 const count=f.seen.length;assert.ok(count>1);await f.audit();assert.equal(f.seen.length,count);
 fail=false;const text='a'.repeat(10000)+'b'+'a'.repeat(29999);f.write(text);
 assert.equal(deliveryDecision(await f.audit()).canFinish,true);assert.equal(f.seen.length,count+1);
});

test('同文件多处读取同时保留，重叠材料只保留一份',async t=>{
 const f=fixture(t),path=join(f.cwd,'contract.txt'),rows=Array.from({length:20},(_,i)=>'定义 '+(i+1)),text=rows.join('\n');writeFileSync(path,text);
 const revision=createHash('sha256').update(text).digest('hex');
 for(const [start,end] of [[1,3],[12,15],[2,5]])f.c.captureRead({}, {details:{source:{absolutePath:path,revision,startLine:start,endLine:end}},content:[{type:'text',text:rows.slice(start-1,end).map((line,i)=>`${start+i}| ${line}`).join('\n')}]},f.ctx);
 f.write('引用已读取的定义');await f.audit();const materials=f.seen[0].evidence.filter(e=>e.path===path);
 assert.equal(materials.length,2);assert.ok(materials.some(e=>e.startLine===1&&e.endLine===5));assert.ok(materials.some(e=>e.startLine===12&&e.endLine===15));
 const combined=materials.map(e=>e.text).join('\n');assert.equal(combined.match(/^2\|/gm).length,1);assert.match(combined,/15\| 定义 15/);
});

test('补证要求指向文件后部时，优先提供实际要求的片段',()=>{
 const prefix='背景信息\n'.repeat(7000),text=prefix+'\n接口 PaymentContract 的退款上限定义';
 const selected=selectEvidence([{id:'E1',path:'contract.txt',text}],undefined,{budget:6000,query:'PaymentContract'});
 assert.ok(selected.selected[0].text.includes('PaymentContract'));assert.equal(selected.selected[0].sourceComplete,false);
});

test('重新分片后原问题全部按稳定ID确认，已恢复的行也会被确认',async t=>{
 const f=fixture(t,(p,count)=>p.reviewContext?.mode==='verify'?confirmed(p):count<=2?{verdict:'reject',findings:[issue(p.change.path,p.change.ranges[0].startLine)],neededEvidence:[],patches:[]}:allow());
 const original=Array.from({length:700},(_,i)=>String(i).padStart(4,'0')+' '+'.'.repeat(100)),changed=[...original];writeFileSync(f.path,original.join('\n'));
 for(const start of [40,500])for(let i=start;i<start+120;i++)changed[i]='changed '+i+' '+':'.repeat(100);
 f.write(changed.join('\n'));const first=await f.audit();assert.equal(first.length,2);const ids=first.flatMap(r=>r.pendingItems.map(i=>i.id));
 changed[40]='fixed 40';for(let i=500;i<620;i++)changed[i]=original[i];f.write(changed.join('\n'));
 const second=await f.audit();assert.equal(deliveryDecision(second).canFinish,true);
 const checks=second.flatMap(r=>r.confirmationChecks??[]);assert.deepEqual(checks.map(c=>c.id).sort(),ids.sort());
 const count=f.seen.length;await f.audit();assert.equal(f.seen.length,count);
});

test('确认材料超过单次预算时分批确认，每个问题只确认一次',async t=>{
 const f=fixture(t,p=>p.reviewContext?p.reviewContext.mode==='verify'?confirmed(p):allow():{verdict:'reject',findings:Array.from({length:35},(_,i)=>issue(p.change.path,i+1)),neededEvidence:[],patches:[]});
 const initial=Array.from({length:40},(_,i)=>'bad '+i+' '+'.'.repeat(450));f.write(initial.join('\n'));const first=await f.audit();const ids=first.flatMap(r=>r.pendingItems.map(i=>i.id));
 f.write(initial.map(row=>row.replace('bad','fix')).join('\n'));const results=await f.audit();
 assert.equal(deliveryDecision(results).canFinish,true);const verify=f.seen.filter(p=>p.reviewContext?.mode==='verify');assert.ok(verify.length>1);
 assert.deepEqual(verify.flatMap(p=>p.reviewContext.items.map(i=>i.id)).sort(),ids.sort());
 assert.ok(results.every(r=>r.confirmationAttempt<=1));assert.ok(verify.every(p=>JSON.stringify(p.reviewContext).length<18000));
});

test('全部还原基线仍逐项确认已有问题',async t=>{
 const f=fixture(t,p=>p.reviewContext?.mode==='verify'?confirmed(p):{verdict:'reject',findings:[issue(p.change.path)],neededEvidence:[],patches:[]});
 writeFileSync(f.path,'baseline');f.write('bad');await f.audit();f.write('baseline');const results=await f.audit();
 assert.equal(deliveryDecision(results).canFinish,true);assert.equal(f.seen.length,2);assert.match(f.seen[1].reviewContext.confirmation_context,/baseline/);
});

test('长行分片不能接受整行替换补丁',()=>{
 const p=candidateInput(partitionChange({path:'source',before:'',after:'x'.repeat(30000)})[0],'v');p.rules=[{id:'business-dictionary-single-source'}];p.evidence=[{id:'CANDIDATE'}];
 assert.throws(()=>validateReview({verdict:'reject',findings:[issue('source')],neededEvidence:[],patches:[{candidateVersion:'v',ruleId:'business-dictionary-single-source',startLine:1,endLine:1,newText:'entire line'}]},p),/分片候选/);
});

test('密集重复行的差异记录仍可以完整重建结果',()=>{
 const before=Array.from({length:1800},(_,i)=>i%2?'before '+i:'repeat').join('\n'),after='inserted\n'+before.replaceAll('before ','after ');
 const diff=lineEdits(before,after),rows=before.split('\n');for(const edit of [...diff.edits].reverse())rows.splice(edit.oldStart,edit.oldEnd-edit.oldStart,...edit.afterLines);
 assert.equal(diff.limited,false);assert.equal(rows.join('\n'),after);
});

test('长行前方插入内容后，原问题按最新列号确认',async t=>{
 const f=fixture(t,p=>{
   if(p.reviewContext?.mode==='verify')return confirmed(p);
   if(p.reviewContext)return allow();
   const span=p.change.fragments?.[0].after;
   return span&&span.startColumn<=9001&&span.endColumn>9001?{verdict:'reject',findings:[issue(p.change.path,1,9001)],neededEvidence:[],patches:[]}:allow();
 });
 const text='a'.repeat(9000)+'problem'+'z'.repeat(22000);f.write(text);const initial=await f.audit(),ids=initial.flatMap(r=>r.pendingItems??[]).map(i=>i.id);assert.equal(ids.length,1);
 f.write('prefix'+text);assert.equal(deliveryDecision(await f.audit()).canFinish,true);
 const verify=f.seen.filter(p=>p.reviewContext?.mode==='verify');assert.equal(verify.length,1);assert.equal(verify[0].reviewContext.items[0].id,ids[0]);assert.ok(verify[0].reviewContext.items[0].finding.location.endsWith(':1:9007'));
});

test('同版本同范围读取不重复补证请求，新增证据行段才继续确认',async t=>{
 const f=fixture(t,p=>p.reviewContext?.mode==='verify'?confirmed(p):{verdict:'needs_evidence',findings:[],neededEvidence:['读取合同后部的真实定义'],patches:[]});
 const path=join(f.cwd,'contract.txt'),text='第一段\n第二段\n第三段\n后部真实定义';writeFileSync(path,text);const revision=createHash('sha256').update(text).digest('hex');
 const read=(startLine,endLine)=>f.c.captureRead({}, {details:{source:{absolutePath:path,revision,startLine,endLine}},content:[{type:'text',text:text.split('\n').slice(startLine-1,endLine).map((row,i)=>`${startLine+i}| ${row}`).join('\n')}]},f.ctx);
 read(1,2);f.write('使用合同定义');await f.audit();assert.equal(f.seen.length,1);
 read(1,2);await f.audit();assert.equal(f.seen.length,1);
 read(4,4);assert.equal(deliveryDecision(await f.audit()).canFinish,true);assert.equal(f.seen.length,2);
});

test('中文补证要求优先命中文件后部的相关定义',()=>{
 const text='旧背景\n'.repeat(4000)+'订单的退款金额不得超过原始支付金额';
 const result=selectEvidence([{id:'E1',path:'contract.txt',text}],undefined,{budget:4000,query:'请读取退款金额的真实定义'});
 assert.ok(result.selected[0].text.includes('退款金额不得超过'));
});

test('明确指定文件行号时优先提供目标行段',()=>{
 const text=Array.from({length:5000},(_,i)=>'无匹配关键词的第'+(i+1)+'行').join('\n');
 const result=selectEvidence([{id:'E1',path:'/workspace/contract.txt',text}],undefined,{budget:4000,query:'读取 contract.txt:4900-4903'});
 assert.ok(result.selected[0].text.includes('第4900行'));assert.ok(result.selected[0].text.includes('第4903行'));
});

test('大量历史证据不会挤掉原问题引用材料',()=>{
 const entries=Array.from({length:200},(_,i)=>({id:'E'+i,path:'tool:old-'+i,text:'older '+i+' '+'.'.repeat(5000)}));
 entries.push({id:'priority',path:'contract.txt',text:'required contract '+'x'.repeat(5000)});
 const previous={result:{review:{findings:[{evidenceRefs:['priority']}]}},selected:[entries.at(-1)]};
 const result=selectEvidence(entries,previous);assert.equal(result.selected[0].id,'priority');assert.ok(result.selected[0].text.includes('required contract'));assert.ok(result.selected.reduce((sum,e)=>sum+e.text.length,0)<=18000);
});
