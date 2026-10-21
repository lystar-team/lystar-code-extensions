import { implementationRoot } from './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const root=implementationRoot,core=await import(root+'/anti-slop.mjs'),client=await import(root+'/review-client.mjs'),base=core.loadConfig().config;
function fixture(){const cwd=mkdtempSync(join(tmpdir(),'luna-batch-cache-')),rulesPath=join(cwd,'rules.json');writeFileSync(rulesPath,JSON.stringify(base));let calls=0;return {cwd,ctx:{cwd,sessionManager:{getBranch:()=>[]}},c:core.createReviewController({}, {rulesPath,ask:async()=>{calls++;return {review:{verdict:'allow',findings:[],neededEvidence:[],patches:[]}}}}),calls:()=>calls};}
test('同版本同读取范围的新snapshot编号不导致重新审查',async()=>{
 const f=fixture(),source=join(f.cwd,'Enum.java'),path=join(f.cwd,'sample.vue');writeFileSync(source,'enum Status {SUCCESS}');const revision=createHash('sha256').update(readFileSync(source)).digest('hex');
 const capture=id=>f.c.captureRead({}, {details:{source:{absolutePath:source,revision,startLine:1,endLine:1}},content:[{type:'text',text:'[snapshot '+id+']\n1| enum Status {SUCCESS}'}]},f.ctx);
 capture('one');await f.c.start(f.ctx);writeFileSync(path,'candidate');f.c.written(path,'','candidate',{status:'pending'});await f.c.finalAudit(f.ctx,[path]);capture('two');await f.c.finalAudit(f.ctx,[path]);assert.equal(f.calls(),1);
});
test('二十五个文件最终检查后复核仍复用各自最新版本',async()=>{
 const f=fixture(),paths=[];await f.c.start(f.ctx);for(let i=0;i<25;i++){const path=join(f.cwd,'sample-'+i+'.vue');writeFileSync(path,'candidate');f.c.written(path,'','candidate',{status:'pending'});paths.push(path);}
 await f.c.finalAudit(f.ctx,paths);assert.equal(f.calls(),25);await f.c.finalAudit(f.ctx,paths);assert.equal(f.calls(),25);
});
test('只读DOMException超时返回准确原因和用量缺口',async t=>{
 const original=new DOMException('只读异常','TimeoutError');t.mock.method(globalThis,'fetch',async(_url,options)=>{await new Promise(resolve=>{const timer=setTimeout(resolve,20);options.signal.addEventListener('abort',()=>{clearTimeout(timer);resolve();},{once:true});});throw original;});
 const ctx={modelRegistry:{getModelOfType:async()=>({api:'openai-responses',baseUrl:'http://fixture.invalid/v1'}),getProviderAuth:async()=>({auth:{apiKey:'fixture-only'}})}};
 await assert.rejects(()=>client.requestReview({}, {...base.reviewer,timeoutMs:5},ctx),error=>{assert.match(error.message,/超过5毫秒/);assert.equal(error.cause,original);assert.equal(error.metrics.inputTokens,null);return true;});assert.equal(original.message,'只读异常');
});
