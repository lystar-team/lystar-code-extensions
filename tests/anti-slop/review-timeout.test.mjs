import './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {requestReview,serializeReviewPayload} from '../../extensions/lystar-jev-anti-slop/review-client.mjs';
import {createReviewController,loadConfig} from '../../extensions/lystar-jev-anti-slop/anti-slop.mjs';
const config=loadConfig().config.reviewer;
const payload={task:'检查本轮',change:{path:'sample.ts',before:'a',after:'b',ranges:[{startLine:1,endLine:1}]},rules:[],evidence:[],candidate_context:'1| b'};
const verdict={verdict:'allow',findings:[],neededEvidence:[],patches:[]};
const completed={type:'response.completed',response:{status:'completed',model:config.model,reasoning:{effort:config.thinkingLevel},output:[{content:[{type:'output_text',text:JSON.stringify(verdict)}]}],usage:{input_tokens:123,output_tokens:12}}};
const frame=event=>'data: '+JSON.stringify(event)+'\n\n';
function fixture(){const dir=mkdtempSync(join(tmpdir(),'slop-timeout-'));return {dir,ctx:{reviewLogPath:join(dir,'requests.jsonl'),currentTurn:{inputId:'turn'},sessionManager:{getSessionId:()=> 'session'},modelRegistry:{getModelOfType:async()=>({api:'openai-responses',baseUrl:'http://fixture.invalid/v1'}),getProviderAuth:async()=>({auth:{apiKey:'fixture-only'}})}},logs(){return readFileSync(this.ctx.reviewLogPath,'utf8').trim().split('\n').map(JSON.parse);}};}
test('流事件、正文和请求大小写入同一请求日志',async t=>{
 const f=fixture();t.mock.method(globalThis,'fetch',async()=>new Response(frame({type:'response.created'})+frame({type:'response.output_text.delta',delta:JSON.stringify(verdict)})+frame(completed)));
 const r=await requestReview(payload,config,f.ctx),logs=f.logs();assert.equal(r.review.verdict,'allow');assert.ok(r.metrics.requestBytes>r.metrics.payloadChars);assert.ok(r.metrics.headersMs<=r.metrics.firstEventMs);assert.ok(r.metrics.firstEventMs<=r.metrics.firstTextMs);assert.equal(r.metrics.inputTokens,123);assert.equal(r.metrics.sections.change,JSON.stringify(JSON.parse(serializeReviewPayload(payload)).change).length);assert.equal(logs.at(-1).event,'response_received');assert.ok(logs.every(e=>e.requestId===r.metrics.requestId&&e.inputId==='turn'&&e.sessionId==='session'));assert.ok(logs.some(e=>e.event==='first_text'));
});
test('响应头等待超时保留阶段、日志和原异常',async t=>{
 const f=fixture();t.mock.method(globalThis,'fetch',async(_url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})));
  await assert.rejects(()=>requestReview(payload,{...config,timeoutMs:15},f.ctx),e=>{assert.equal(e.metrics.stage,'await_headers');assert.equal(e.metrics.headersMs,null);assert.equal(e.metrics.failureReason,'timeout');assert.equal(e.metrics.logPath,f.ctx.reviewLogPath);assert.ok(e.cause);assert.equal(e.message.includes('日志'),false);return true;});assert.equal(f.logs().at(-1).event,'timeout');
});
test('已收到流事件但未出正文，超时能区别模型输出等待',async t=>{
 const f=fixture();t.mock.method(globalThis,'fetch',async(_url,{signal})=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(frame({type:'response.created'})));signal.addEventListener('abort',()=>controller.error(signal.reason),{once:true});}})));
 await assert.rejects(()=>requestReview(payload,{...config,timeoutMs:20},f.ctx),e=>{assert.equal(e.metrics.stage,'await_text');assert.notEqual(e.metrics.firstEventMs,null);assert.equal(e.metrics.firstTextMs,null);assert.equal(e.metrics.lastEventType,'response.created');return true;});assert.equal(f.logs().at(-1).stage,'await_text');
});
test('延长预算允许较慢完整响应，不自动重试；用户取消不是超时',async t=>{
 const f=fixture();let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,35));return new Response(frame(completed));});const r=await requestReview(payload,{...config,timeoutMs:200},f.ctx);assert.equal(r.review.verdict,'allow');assert.ok(r.metrics.totalMs>=30);assert.equal(calls,1);
 const abort=new AbortController();abort.abort();t.mock.method(globalThis,'fetch',async(_url,{signal})=>{signal.throwIfAborted();});await assert.rejects(()=>requestReview(payload,config,{...f.ctx,signal:abort.signal}),e=>{assert.equal(e.metrics.failureReason,'cancelled');return true;});assert.equal(f.logs().at(-1).event,'cancelled');
});
test('日志写入失败不破坏文件工具和审查结果，诊断明确报错',async t=>{
 const f=fixture(),file=join(f.dir,'file');writeFileSync(file,'not a directory');f.ctx.reviewLogPath=join(file,'request.jsonl');t.mock.method(globalThis,'fetch',async()=>new Response(frame(completed)));const r=await requestReview(payload,config,f.ctx);assert.equal(r.review.verdict,'allow');assert.ok(r.metrics.logError);
});
test('审查失败仍保留候选行段，不以空范围掩盖超时',async()=>{
 const f=fixture(),path=join(f.dir,'sample.ts'),c=createReviewController({}, {ask:async()=>{throw Object.assign(new Error('超时'),{metrics:{failureReason:'timeout'}});}});writeFileSync(path,'a\nb\nc');c.written(path,'a\nold\nc','a\nb\nc',{status:'pending'});const [r]=await c.finalAudit({...f.ctx,cwd:f.dir});assert.equal(r.status,'unchecked');assert.deepEqual(r.ranges,[{startLine:2,endLine:2}]);assert.equal(r.failureReason,'timeout');
});
