import './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createReviewController,readSource,deliveryDecision,loadConfig} from '../../extensions/lystar-jev-anti-slop/anti-slop.mjs';
import {serializeReviewPayload,requestReview} from '../../extensions/lystar-jev-anti-slop/review-client.mjs';
import {CONTEXT_LIMIT} from '../../extensions/lystar-jev-anti-slop/line-ranges.mjs';

const allow=()=>({verdict:'allow',findings:[],neededEvidence:[],patches:[]});
function fixture(t,ask){
 const cwd=mkdtempSync(join(tmpdir(),'slop-source-scope-'));
 t.after(()=>rmSync(cwd,{recursive:true,force:true}));
 const seen=[],ctx={cwd,reviewLogPath:join(cwd,'audit.jsonl')};
 const c=createReviewController({}, {ask:ask??(async payload=>{seen.push(payload);return {review:allow(),metrics:{simulation:true}};})});
 return {cwd,ctx,c,seen,logs:()=>readFileSync(ctx.reviewLogPath,'utf8').trim().split('\n').map(JSON.parse)};
}
async function record(f,path,before,after){
 const report=await f.c.beforeWrite(path,before,after,f.ctx);
 writeFileSync(path,after);f.c.written(path,before,after,report);return report;
}
const largeLines=()=>Array.from({length:7000},(_,i)=>`${i}: ${'unchanged '.repeat(11)}`);

test('超过200KB的文档只改一行时，仅发送该行及必要上下文',async t=>{
 const f=fixture(t),path=join(f.cwd,'CHANGELOG.md'),a=largeLines(),b=[...a];
 b[3500]='- 修复会话切换后旧结果覆盖当前会话的问题。';
 const before=a.join('\n'),after=b.join('\n');
 assert.ok(Buffer.byteLength(after)>600000);
 assert.equal((await record(f,path,before,after)).status,'pending');
 assert.equal(readSource(path),after);
 const results=await f.c.finalAudit(f.ctx);
 assert.equal(deliveryDecision(results).canFinish,true);assert.equal(f.seen.length,1);
 const sent=JSON.parse(serializeReviewPayload(f.seen[0]));
 assert.deepEqual(sent.change.ranges,[{startLine:3501,endLine:3501}]);
 assert.ok(sent.candidate_context.includes('3501| '+b[3500]));
 assert.ok(!sent.candidate_context.includes(a[100]));
 assert.equal(sent.change.before,a[3500]);assert.equal(sent.change.after,undefined);
 assert.equal(sent.change.afterFrom,'candidate_context');
 assert.ok(sent.candidate_context.length<2000);
 assert.equal(results[0].scopeDiagnostics.sourceBytes,Buffer.byteLength(after));
});

test('超过200KB的源码有多个修改段时，分组覆盖全部范围并复用缓存',async t=>{
 const f=fixture(t),path=join(f.cwd,'runtime.ts'),a=largeLines(),b=[...a];
 for(let i=40;i<160;i++)b[i]=`${i}: ${'first correction '.repeat(7)}`;
 for(let i=5500;i<5620;i++)b[i]=`${i}: ${'second correction '.repeat(7)}`;
 await record(f,path,a.join('\n'),b.join('\n'));
 const results=await f.c.finalAudit(f.ctx);
 assert.equal(results.length,2);assert.equal(f.seen.length,2);
 assert.deepEqual(results.flatMap(r=>r.ranges),[{startLine:41,endLine:160},{startLine:5501,endLine:5620}]);
 assert.ok(f.seen.every(p=>p.coverageComplete&&p.candidate_context.length<=CONTEXT_LIMIT));
 assert.equal(deliveryDecision(results).canFinish,true);
 assert.equal((await f.c.finalAudit(f.ctx)).audit.modelRequests,0);assert.equal(f.seen.length,2);
});

test('大文件纯删除保留被删除内容和空范围',async t=>{
 const f=fixture(t),path=join(f.cwd,'CHANGELOG.md'),a=largeLines(),b=[...a];b.splice(3500,1);
 await record(f,path,a.join('\n'),b.join('\n'));
 assert.equal(deliveryDecision(await f.c.finalAudit(f.ctx)).canFinish,true);
 assert.equal(f.seen[0].change.before,a[3500]);assert.equal(f.seen[0].change.after,'');
 assert.deepEqual(f.seen[0].change.ranges,[{startLine:3501,endLine:3500}]);
});

for(const [ext,before,after] of [
 ['.sh','echo old','echo updated'],['.ps1','Write-Output old','Write-Output updated'],['.cmd','@echo old','@echo updated'],
 ['.sql','select 1','select 2'],['.xml','<old/>','<updated/>'],['.toml','old=1','new=2'],['.txt','旧内容','新内容'],['.svg','<svg/>','<svg></svg>'],['.unknown','old','updated'],['','old','updated']
])test(`${ext}脚本经过写入前判断、读取和最终审查`,async t=>{
 const f=fixture(t),path=join(f.cwd,'install'+ext);
 assert.equal((await record(f,path,before,after)).status,'pending');assert.equal(readSource(path),after);
 assert.equal(deliveryDecision(await f.c.finalAudit(f.ctx)).canFinish,true);assert.equal(f.seen.length,1);
});

test('二进制内容按内容识别，在状态和日志保留明确原因',async t=>{
 const f=fixture(t),path=join(f.cwd,'asset.md');
 const report=await record(f,path,'old','\u0000\u0001binary');
 assert.equal(report.failureReason,'non_text_content');assert.equal(readSource(path),undefined);
 const results=await f.c.finalAudit(f.ctx),r=results[0];
 assert.equal(r.status,'unchecked');assert.equal(r.failureReason,'non_text_content');
 assert.equal(r.apiAttempted,false);assert.equal(results.audit.modelRequests,0);assert.equal(f.seen.length,0);
 assert.equal(f.c.status().latest[0].failureReason,'non_text_content');
 assert.equal(f.logs().at(-1).unchecked[0].failureReason,'non_text_content');
});

test('巨大单行分片完成审查，原字符不遗漏，重复调用使用缓存',async t=>{
 const f=fixture(t),path=join(f.cwd,'large.ts'),after='x'.repeat(210000);
 await record(f,path,'',after);
 const results=await f.c.finalAudit(f.ctx);
 assert.ok(results.length>1);assert.ok(results.every(r=>r.status==='checked'&&r.review.verdict==='allow'));
 assert.equal(f.seen.map(p=>p.change.after).join(''),after);
 assert.ok(f.seen.every(p=>p.coverageComplete&&p.candidate_context.length<=CONTEXT_LIMIT));
 assert.equal(deliveryDecision(results).nextAction,'finish');
 const calls=f.seen.length;assert.equal((await f.c.finalAudit(f.ctx)).audit.modelRequests,0);assert.equal(f.seen.length,calls);
});

test('密集交错修改使用公共锚点定位，所有实际修改进入审查',async t=>{
 const f=fixture(t),path=join(f.cwd,'changes.ts');
 const before=Array.from({length:600},(_,i)=>`keep\nold${i}`).join('\n');
 const after=Array.from({length:600},(_,i)=>`keep\nnew${i}`).join('\n');
 await record(f,path,before,after);const results=await f.c.finalAudit(f.ctx);
 assert.equal(deliveryDecision(results).canFinish,true);assert.ok(f.seen.length>0);
 assert.deepEqual(f.seen.flatMap(p=>p.change.ranges).map(r=>r.startLine),Array.from({length:600},(_,i)=>i*2+2));
 assert.equal(f.seen.map(p=>p.change.after).join('\n'),Array.from({length:600},(_,i)=>'new'+i).join('\n'));
});

test('读取失败单独报告，不再归为文件类型或体量不支持',async t=>{
 const f=fixture(t),path=join(f.cwd,'directory.md');mkdirSync(path);f.c.written(path,'','text',{status:'pending'});
 const results=await f.c.finalAudit(f.ctx);
 assert.equal(results[0].failureReason,'source_read_error');assert.equal(results[0].stage,'read_source');
 assert.equal(results.audit.modelRequests,0);assert.equal(f.logs().at(-1).unchecked[0].failureReason,'source_read_error');
});

test('并发重叠带冲突原因与行段，继续使用回读合并决策',async t=>{
 const f=fixture(t),path=join(f.cwd,'shared.ts');await record(f,path,'before','own');writeFileSync(path,'concurrent');
 const results=await f.c.finalAudit(f.ctx);
 assert.equal(results[0].failureReason,'overlapping_changes');assert.deepEqual(results[0].ranges,results[0].conflicts);
 assert.equal(deliveryDecision(results).nextAction,'read_and_merge');assert.equal(f.seen.length,0);
});

test('完整响应的审查结构无效时保留用量并标明响应无效',async t=>{
 const f=fixture(t,async()=>({review:{verdict:'unknown'},metrics:{inputTokens:123,totalMs:5}})),path=join(f.cwd,'invalid.ts');
 await record(f,path,'before','after');const results=await f.c.finalAudit(f.ctx);
 assert.equal(results[0].failureReason,'invalid_response');assert.equal(results[0].inputTokens,123);
 assert.equal(f.logs().at(-1).unchecked[0].failureReason,'invalid_response');
});

test('远端返回无效JSON时归为响应校验失败并记录阶段',async t=>{
 const f=fixture(t),config=loadConfig().config.reviewer;
 const response={status:'completed',model:config.model,reasoning:{effort:config.thinkingLevel},output:[{content:[{type:'output_text',text:'not json'}]}]};
 t.mock.method(globalThis,'fetch',async()=>new Response('data: '+JSON.stringify({type:'response.completed',response})+'\n\n'));
 const ctx={...f.ctx,modelRegistry:{getModelOfType:async()=>({api:'openai-responses',baseUrl:'http://fixture.invalid/v1'}),getProviderAuth:async()=>({auth:{apiKey:'fixture-only'}})}};
 await assert.rejects(()=>requestReview({change:{path:'invalid.ts',before:'',after:'text'},rules:[],evidence:[]},config,ctx),error=>{
  assert.equal(error.metrics.failureReason,'invalid_response');assert.equal(error.metrics.stage,'validate_response');return true;
 });
 assert.equal(f.logs().at(-1).event,'validation_error');
});
