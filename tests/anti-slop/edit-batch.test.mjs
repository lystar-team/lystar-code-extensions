import { implementationRoot } from './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const core=await import((implementationRoot)+'/anti-slop.mjs');
const base=core.loadConfig().config;
const allow=()=>({review:{verdict:'allow',findings:[],neededEvidence:[],patches:[]},metrics:{simulation:true}});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(ask=async()=>allow()){
 const cwd=mkdtempSync(join(tmpdir(),'luna-edit-batch-')),rulesPath=join(cwd,'rules.json');writeFileSync(rulesPath,JSON.stringify(base));
 const ctx={cwd,sessionManager:{getBranch:()=>[]}},controller=core.createReviewController({}, {rulesPath,ask});return {cwd,rulesPath,ctx,c:controller};
}
async function edit(f,path,after,id='edit',tool='write'){
 const before=(()=>{try{return readFileSync(path,'utf8')}catch{return ''}})();
 const token=f.c.beginEdit(path,{callId:id,tool,origin:'user'});
 const result=await f.c.beforeWrite(path,before,after,f.ctx);writeFileSync(path,after);f.c.written(path,before,after,result,token);f.c.endEdit(token);return result;
}
test('连续五次编辑只审最终版本，未变复核复用，修正后再审',async()=>{
 const seen=[],f=fixture(async p=>{seen.push(p);return allow()}),path=join(f.cwd,'sample.vue');
 for(let i=1;i<=5;i++)assert.equal((await edit(f,path,'<p>'+i+'</p>','edit-'+i)).status,'pending');
 assert.equal(seen.length,0);assert.equal(f.c.status().files[0].multipleEdits,true);
 assert.equal((await f.c.finalAudit(f.ctx,[path]))[0].review.verdict,'allow');assert.equal(seen.length,1);assert.ok(seen[0].candidate_context.includes('<p>5</p>'));
 assert.equal((await f.c.finalAudit(f.ctx,[path]))[0].cacheReused,true);assert.equal(seen.length,1);
 await edit(f,path,'<p>fixed</p>');await f.c.finalAudit(f.ctx,[path]);assert.equal(seen.length,2);
});
test('新文件经符号链接父目录创建后，相对和绝对路径仍归同一文件',async()=>{
 const f=fixture(),dir=join(f.cwd,'real'),alias=join(f.cwd,'alias');mkdirSync(dir);symlinkSync(dir,alias,process.platform==='win32'?'junction':'dir');
 await edit(f,join(alias,'new.vue'),'first','one');await edit(f,join(dir,'new.vue'),'second','two');
 const files=f.c.status().files;assert.equal(files.length,1);assert.equal(files[0].editCalls,2);assert.equal(files[0].changes,2);assert.equal(files[0].aliases.length,2);
 const results=await f.c.finalAudit(f.ctx,[join(alias,'new.vue'),join(dir,'new.vue')]);assert.equal(results.length,1);
});
test('同名文件位于不同目录时不合并',async()=>{
 const f=fixture();for(const name of ['a','b']){mkdirSync(join(f.cwd,name));await edit(f,join(f.cwd,name,'sample.vue'),name);}
 assert.equal(f.c.status().files.length,2);assert.equal((await f.c.finalAudit(f.ctx)).length,2);
});
test('失败调用和已应用重试不计为成功改动',async()=>{
 const f=fixture(),path=join(f.cwd,'sample.vue');await edit(f,path,'changed');
 const repeated=f.c.beginEdit(path,{callId:'retry',tool:'edit'});f.c.endEdit(repeated,{alreadyApplied:true});f.c.endEdit(repeated);
 const failed=f.c.beginEdit(path,{callId:'failure',tool:'edit'});f.c.endEdit(failed,{failed:true});
 const state=f.c.status().files[0];assert.equal(state.editCalls,3);assert.equal(state.changes,1);assert.equal(state.noOpCalls,1);assert.equal(state.failedCalls,1);assert.equal(state.active,0);assert.equal(state.multipleEdits,false);assert.equal(state.calls[1].outcome,'already_applied');
});
test('一次整批编辑多个片段仍计为一次实际文件改动',async()=>{
 const f=fixture(),path=join(f.cwd,'sample.vue');writeFileSync(path,'a\nb\nc');await edit(f,path,'A\nb\nC','one-batch','edit');
 assert.equal(f.c.status().files[0].changes,1);assert.equal(f.c.status().files[0].multipleEdits,false);
});
test('并发写入全部结束前不调用模型，结束后只审最新内容',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;return allow()}),path=join(f.cwd,'sample.vue');await f.c.start(f.ctx);
 const a=f.c.beginEdit(path,{callId:'a'}),b=f.c.beginEdit(path,{callId:'b'});const audit=f.c.finalAudit(f.ctx,[path]);await tick();assert.equal(calls,0);
 writeFileSync(path,'first');f.c.written(path,'','first',{status:'pending'},a);f.c.endEdit(a);await tick();assert.equal(calls,0);
 writeFileSync(path,'second');f.c.written(path,'first','second',{status:'pending'},b);f.c.endEdit(b);
 assert.equal((await audit)[0].review.verdict,'allow');assert.equal(calls,1);assert.equal(f.c.status().files[0].active,0);
});
test('同时复核同一最终版本共用一条在途请求',async()=>{
 let calls=0;const gate=Promise.withResolvers(),f=fixture(async()=>{calls++;await gate.promise;return allow()}),path=join(f.cwd,'sample.vue');await edit(f,path,'final');
 const first=f.c.finalAudit(f.ctx,[path]),second=f.c.finalAudit(f.ctx,[path]);await tick();assert.equal(calls,1);gate.resolve();
 const results=await Promise.all([first,second]);assert.ok(results.some(r=>r[0].inFlightReused));assert.equal(calls,1);
});
test('审查期间再次编辑会废弃旧结论，下一次检查最新版本',async()=>{
 let calls=0;const gate=Promise.withResolvers(),f=fixture(async()=>{calls++;if(calls===1)await gate.promise;return allow()}),path=join(f.cwd,'sample.vue');await edit(f,path,'old');
 const audit=f.c.finalAudit(f.ctx,[path]);await tick();await edit(f,path,'new');gate.resolve();
 const old=(await audit)[0];assert.equal(old.status,'unchecked');assert.equal(old.stale,true);assert.equal(old.review,undefined);
 assert.equal((await f.c.finalAudit(f.ctx,[path]))[0].review.verdict,'allow');assert.equal(calls,2);
});
test('多次编辑最终还原基线时无需模型调用',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;return allow()}),path=join(f.cwd,'sample.vue');writeFileSync(path,'original');await edit(f,path,'changed');await edit(f,path,'original');
 assert.equal((await f.c.finalAudit(f.ctx,[path]))[0].skip,'no-change');assert.equal(calls,0);
});
test('只写入一次的文件在完成边界也会审查',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;return allow()}),path=join(f.cwd,'sample.vue');await edit(f,path,'once');assert.equal(calls,0);
 await f.c.finalAudit(f.ctx,[path]);assert.equal(calls,1);assert.equal(f.c.status().files[0].multipleEdits,false);
});
test('只有write边界的启用规则在合并审查时仍发送',async()=>{
 const seen=[],f=fixture(async p=>{seen.push(p);return allow()}),path=join(f.cwd,'sample.vue'),config=structuredClone(base);config.rules[0].checkAt=['write'];writeFileSync(f.rulesPath,JSON.stringify(config));
 await edit(f,path,'candidate');await f.c.finalAudit(f.ctx,[path]);assert.ok(seen[0].rules.some(r=>r.id===config.rules[0].id));
});
test('等待写入期间取消复核，不产生通过结论或模型请求',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;return allow()}),abort=new AbortController(),path=join(f.cwd,'sample.vue');await f.c.start(f.ctx);const token=f.c.beginEdit(path);f.ctx.signal=abort.signal;
 const audit=f.c.finalAudit(f.ctx,[path]);await tick();abort.abort();await assert.rejects(()=>audit,/Operation aborted/);f.c.endEdit(token,{failed:true});assert.equal(calls,0);
});
