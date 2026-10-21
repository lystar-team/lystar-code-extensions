import './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createReviewController,loadConfig,validateConfig,deliveryDecision,candidateInput} from '../../extensions/lystar-jev-anti-slop/anti-slop.mjs';
import {selectEvidence} from '../../extensions/lystar-jev-anti-slop/review-evidence.mjs';
import {serializeReviewPayload,REVIEW_SYSTEM,requestReview} from '../../extensions/lystar-jev-anti-slop/review-client.mjs';
const allow=()=>({verdict:'allow',findings:[],neededEvidence:[],patches:[]});
const issue=p=>({ruleId:'business-dictionary-single-source',location:p.change.path+':'+p.change.ranges[0].startLine,problem:'固定协议问题',suggestion:'固定协议标准',evidenceRefs:['CANDIDATE']});
const rejected=p=>({verdict:'reject',findings:[issue(p)],neededEvidence:[],patches:[]});
function confirmed(p,resolved=true){return {...resolved?allow():{verdict:'reject',findings:p.reviewContext.items.filter(i=>i.kind==='finding').map(i=>i.finding),neededEvidence:[],patches:[]},checks:p.reviewContext.items.map(i=>({id:i.id,state:resolved?'resolved':'unresolved',reason:'固定协议依据',evidenceRefs:['CANDIDATE']})),findingSources:resolved?[]:p.reviewContext.items.map((item,i)=>({findingIndex:i,checkId:item.id,correctionIndex:-1,beforeSnippet:'',afterSnippet:'',reason:'原问题仍存在'}))};}
function fixture(ask){const cwd=mkdtempSync(join(tmpdir(),'slop-efficiency-')),ctx={cwd,reviewLogPath:join(cwd,'audit.jsonl'),sessionManager:{getBranch:()=>[]}},c=createReviewController({}, {ask});return {cwd,ctx,c,write(path,text){let before='';try{before=readFileSync(path,'utf8');}catch{}writeFileSync(path,text);c.written(path,before,text,{status:'pending'});},audit(){return c.finalAudit(ctx);}};}
const stamp=text=>createHash('sha256').update(text).digest('hex');

test('第二次确认仍未解决时立即停止，相同结果也保持停止',async()=>{
 let calls=0;const f=fixture(async p=>({review:++calls===1?rejected(p):confirmed(p,false)})),path=join(f.cwd,'stop.ts');
 f.write(path,'bad');await f.audit();f.write(path,'fix1');await f.audit();f.write(path,'fix2');const second=await f.audit();
 assert.equal(second[0].confirmationAttempt,2);assert.equal(deliveryDecision(second).nextAction,'report_remaining');assert.equal(deliveryDecision(await f.audit()).shouldStop,true);assert.equal(calls,3);
});
test('相同失败候选只请求一次；内容实际改变才重新检查',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;throw Object.assign(new Error('固定超时'),{metrics:{failureReason:'timeout'}})}),path=join(f.cwd,'failed.ts');
 f.write(path,'candidate');await f.audit();f.c.addEvidence('tool:status','无关状态');const same=await f.audit();assert.equal(calls,1);assert.equal(same[0].cacheReused,true);assert.equal(deliveryDecision(same).canFinish,false);
 f.write(path,'new candidate');await f.audit();assert.equal(calls,2);
});
test('已通过候选新增无关证据不重复请求',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;return {review:allow()}}),path=join(f.cwd,'passed.ts');f.write(path,'passed');await f.audit();f.c.addEvidence('tool:status','其他工具状态');await f.audit();assert.equal(calls,1);
});
test('证据变化保留原问题ID与确认标准，不退回首次检查',async()=>{
 const seen=[],f=fixture(async p=>{seen.push(p);return {review:p.reviewContext?.mode==='verify'?confirmed(p,false):rejected(p)}}),path=join(f.cwd,'candidate.ts'),source=join(f.cwd,'source.ts');
 writeFileSync(source,'v1');f.c.addEvidence(source,'v1',{revision:stamp('v1')});f.write(path,'bad');await f.audit();const id=seen[0].candidate.version+'-finding-1';
 writeFileSync(source,'v2');f.c.addEvidence(source,'v2',{revision:stamp('v2')});f.write(path,'fix1');await f.audit();assert.equal(seen[1].reviewContext.mode,'verify');assert.equal(seen[1].reviewContext.items[0].id,id);
 f.write(path,'fix2');await f.audit();assert.equal(seen[2].reviewContext.items[0].id,id);
});
test('单文件三分段共用一次修正确认轮次',async()=>{
 const seen=[],f=fixture(async p=>{seen.push(p);return {review:p.reviewContext?.mode==='verify'?confirmed(p):rejected(p)}}),path=join(f.cwd,'large.ts'),a=Array.from({length:1100},(_,i)=>String(i).padStart(4,'0')+' '+'.'.repeat(100)),b=[...a];writeFileSync(path,a.join('\n'));
 for(const start of [40,500,900])for(let i=start;i<start+120;i++)b[i]='changed '+i+' '+':'.repeat(100);f.write(path,b.join('\n'));assert.equal((await f.audit()).length,3);
 for(const start of [40,500,900])b[start]='fixed '+start+' '+':'.repeat(100);f.write(path,b.join('\n'));const result=await f.audit();assert.equal(deliveryDecision(result).canFinish,true);assert.deepEqual(result.map(r=>r.confirmationAttempt),[1,1,1]);assert.equal(seen.length,6);
});
test('问题行还原基线后仍有最新只读源码供确认，不扩大补丁范围',async()=>{
 const seen=[],f=fixture(async p=>{seen.push(p);return {review:p.reviewContext?.mode==='verify'?confirmed(p):rejected(p)}}),path=join(f.cwd,'revert.ts'),a=Array.from({length:60},(_,i)=>'baseline '+i),b=[...a];writeFileSync(path,a.join('\n'));b[2]='bad';b[50]='other change';f.write(path,b.join('\n'));await f.audit();b[2]=a[2];f.write(path,b.join('\n'));const final=await f.audit(),p=seen[1];assert.equal(deliveryDecision(final).canFinish,true);assert.deepEqual(p.change.ranges,[{startLine:51,endLine:51}]);assert.ok(p.reviewContext.confirmation_context.includes('3| baseline 2'));assert.ok(p.reviewContext.corrections.some(c=>c.startLine===3&&c.after==='baseline 2'));
});
test('证据预算优先保留最新源码和已引用证据，去重且报告省略',()=>{
 const old=[1,2,3].map(n=>({id:'E'+n,path:'tool:old'+n,text:'OLD'+n+'x'.repeat(6500)})),latest={id:'E4',path:'API.ts',text:'LATEST_API'+'y'.repeat(6500)},p=selectEvidence([...old,latest]);assert.equal(p.selected[0].path,'API.ts');assert.ok(p.omitted.some(e=>e.reason==='partial'));assert.ok(p.selected.reduce((sum,e)=>sum+e.text.length,0)<=18000);
 const duplicate=selectEvidence([{id:'a',path:'a.ts',text:'same'},{id:'b',path:'b.ts',text:'same'}]);assert.equal(duplicate.selected.length,1);assert.equal(duplicate.omitted[0].reason,'duplicate');
 const prioritized=selectEvidence([...old,latest],{result:{review:{findings:[{evidenceRefs:['E1']}]}},selected:[old[0]]});assert.equal(prioritized.selected[0].id,'E1');
});
test('发送文本去掉重复after，保留规则例外、编号源码与删除范围',()=>{
 const p={...candidateInput({path:'sample.ts',before:'original',after:'x'.repeat(2000)},'v'),rules:loadConfig().config.rules},wire=serializeReviewPayload(p),sent=JSON.parse(wire);assert.equal(sent.change.after,undefined);assert.equal(sent.change.afterFrom,'candidate_context');assert.equal(sent.candidate_context,p.candidate_context);assert.deepEqual(sent.rules,p.rules);assert.ok(wire.length<JSON.stringify(p).length-1800);
 const deletion=JSON.parse(serializeReviewPayload(candidateInput({path:'sample.ts',before:'a\nremove\nb',after:'a\nb'},'v')));assert.deepEqual(deletion.change.ranges,[{startLine:2,endLine:1}]);assert.equal(deletion.change.before,'remove');
});
test('场景只作为LLM判断依据，前后端同语言与文档都发送完整启用规则',async()=>{
 const seen=[],f=fixture(async p=>{seen.push(p);return {review:allow()}});for(const path of ['frontend.ts','backend.ts','说明.md']){f.write(join(f.cwd,path),'本地协议候选');await f.audit();}
  assert.equal(seen.length,3);const enabled=loadConfig().config.rules.filter(r=>r.enabled);assert.ok(seen.every(p=>JSON.stringify(p.rules)===JSON.stringify(enabled)&&p.rules.every(r=>r.scenarios.length)));assert.ok(REVIEW_SYSTEM.includes('不单凭语言后缀分类'));const invalid=structuredClone(loadConfig().config);invalid.rules[0].scenarios=['unknown'];assert.throws(()=>validateConfig(invalid));
});
test('不同文件最多两路并发，缓存命中和整次耗时写入汇总',async()=>{
 let active=0,peak=0;const f=fixture(async()=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,40));active--;return {review:allow()}});for(let i=0;i<4;i++)f.write(join(f.cwd,'file'+i+'.ts'),'candidate '+i);
 const result=await f.audit();assert.equal(peak,2);assert.equal(result.audit.fileCount,4);assert.equal(result.audit.modelRequests,4);assert.equal(result.audit.decision.nextAction,'finish');const cached=await f.audit();assert.equal(cached.audit.modelRequests,0);assert.equal(cached.audit.cacheHits,4);
 const logs=readFileSync(f.ctx.reviewLogPath,'utf8').trim().split('\n').map(JSON.parse);assert.equal(logs.filter(e=>e.event==='audit_completed').length,2);assert.equal(logs.at(-1).modelRequests,0);assert.ok(logs.at(-1).summary.includes('缓存命中4'));console.log('本地固定40ms响应：4文件并发检查耗时'+result.audit.totalMs+'ms，峰值并发'+peak);
});
test('完整响应与程序校验失败分别记录，不把无效allow记成通过',async t=>{
 const f=fixture(),config=loadConfig().config.reviewer;const output={...allow(),findings:[{ruleId:'unknown'}]},event={type:'response.completed',response:{status:'completed',model:config.model,reasoning:{effort:config.thinkingLevel},output:[{content:[{type:'output_text',text:JSON.stringify(output)}]}]}};
 t.mock.method(globalThis,'fetch',async()=>new Response('data: '+JSON.stringify(event)+'\n\n'));
 const c=createReviewController({}, {ask:requestReview}),path=join(f.cwd,'invalid.ts');writeFileSync(path,'candidate');c.written(path,'','candidate',{status:'pending'});assert.equal((await c.finalAudit({...f.ctx,modelRegistry:{getModelOfType:async()=>({api:'openai-responses',baseUrl:'http://fixture.invalid/v1'}),getProviderAuth:async()=>({auth:{apiKey:'fixture-only'}})}}))[0].status,'unchecked');
 const events=readFileSync(f.ctx.reviewLogPath,'utf8').trim().split('\n').map(JSON.parse).map(e=>e.event);assert.ok(events.includes('response_received'));assert.ok(events.includes('validation_error'));assert.ok(!events.includes('completed'));
});
