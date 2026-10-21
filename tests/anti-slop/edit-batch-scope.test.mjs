import './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const core=await import('../../extensions/lystar-jev-anti-slop/anti-slop.mjs'),base=core.loadConfig().config;
function workspace(){const cwd=mkdtempSync(join(tmpdir(),'luna-scope-')),rulesPath=join(cwd,'rules.json');writeFileSync(rulesPath,JSON.stringify(base));return {cwd,rulesPath};}
function session(w){const seen=[],ctx={cwd:w.cwd,sessionManager:{getBranch:()=>[]}},c=core.createReviewController({}, {rulesPath:w.rulesPath,ask:async p=>{seen.push(p);return {review:{verdict:'allow',findings:[],neededEvidence:[],patches:[]}}}});return {c,ctx,seen};}
function written(s,path,content){let before='';try{before=readFileSync(path,'utf8')}catch{}writeFileSync(path,content);s.c.written(path,before,content,{status:'pending'});}
test('两个会话同项目同时修改，各自审批只包含自己文件',async()=>{
 const w=workspace(),a=session(w),b=session(w),pa=join(w.cwd,'a.vue'),pb=join(w.cwd,'b.vue');written(a,pa,'a');written(b,pb,'b');
 const [ra,rb]=await Promise.all([a.c.finalAudit(a.ctx),b.c.finalAudit(b.ctx)]);assert.deepEqual(ra.map(r=>r.path),[pa]);assert.deepEqual(rb.map(r=>r.path),[pb]);assert.equal(a.seen[0].change.path,pa);assert.equal(b.seen[0].change.path,pb);
});
test('显式路径不能把其他会话或只读文件纳入本轮审批',async()=>{
 const w=workspace(),a=session(w),b=session(w),path=join(w.cwd,'other.vue');written(b,path,'other');a.c.addEvidence(path,'已读取');
 const result=(await a.c.finalAudit(a.ctx,[path]))[0];assert.equal(result.outsideScope,true);assert.equal(result.status,'unchecked');assert.equal(a.seen.length,0);
});
test('同会话下一轮只操作新文件，旧轮文件不自动进入范围',async()=>{
 const w=workspace(),first=session(w),second=session(w),old=join(w.cwd,'old.vue'),fresh=join(w.cwd,'fresh.vue');second.ctx.sessionManager=first.ctx.sessionManager;written(first,old,'old');written(second,fresh,'fresh');
 assert.deepEqual((await second.c.finalAudit(second.ctx)).map(r=>r.path),[fresh]);assert.equal((await second.c.finalAudit(second.ctx,[old]))[0].outsideScope,true);
});
test('同文件被其他会话覆盖，不能审查其内容或复用原通过结论',async()=>{
 const w=workspace(),a=session(w),b=session(w),path=join(w.cwd,'shared.vue');written(a,path,'a');await a.c.finalAudit(a.ctx);written(b,path,'b');
 const result=(await a.c.finalAudit(a.ctx))[0];assert.equal(result.stale,true);assert.equal(result.status,'unchecked');assert.equal(result.review,undefined);assert.equal(a.seen.length,1);assert.equal((await b.c.finalAudit(b.ctx))[0].review.verdict,'allow');
});
test('其他会话把文件还原为当前轮基线，也不能误报零差异通过',async()=>{
 const w=workspace(),a=session(w),path=join(w.cwd,'shared.vue');writeFileSync(path,'baseline');written(a,path,'own');writeFileSync(path,'baseline');
 const result=(await a.c.finalAudit(a.ctx,[path]))[0];assert.equal(result.stale,true);assert.equal(result.status,'unchecked');assert.equal(a.seen.length,0);
});
