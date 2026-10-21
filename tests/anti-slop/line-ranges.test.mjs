import './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {lineEdits,rebaseOwned,candidateInput,partitionChange} from '../../extensions/lystar-jev-anti-slop/line-ranges.mjs';
import {createReviewController,loadConfig,validateReview} from '../../extensions/lystar-jev-anti-slop/anti-slop.mjs';
function fixture(){const cwd=mkdtempSync(join(tmpdir(),'luna-lines-')),rulesPath=join(cwd,'rules.json');writeFileSync(rulesPath,JSON.stringify(loadConfig().config));return {cwd,rulesPath};}
function session(f){const seen=[],c=createReviewController({}, {rulesPath:f.rulesPath,ask:async p=>{seen.push(p);return {review:{verdict:'allow',findings:[],neededEvidence:[],patches:[]}}}}),ctx={cwd:f.cwd,sessionManager:{getBranch:()=>[]}};return {c,ctx,seen};}
function write(s,path,text){const before=readFileSync(path,'utf8');writeFileSync(path,text);s.c.written(path,before,text,{status:'pending'});}
function capture(s,path,start=1,end=100){const text=readFileSync(path,'utf8'),revision=createHash('sha256').update(text).digest('hex');s.c.captureRead({}, {details:{source:{absolutePath:path,revision,startLine:start,endLine:end}},content:[{type:'text',text}]},s.ctx);return revision;}
const document=()=>Array.from({length:40},(_,i)=>'line '+(i+1));
test('重复行差异精确重建，不把未改重复块扩大为修改',()=>{
 for(let n=0;n<1000;n++){const a=Array.from({length:n%8},(_,i)=>String((n+i*3)%4)),b=Array.from({length:(n*3)%9},(_,i)=>String((n*5+i*2)%4)),diff=lineEdits(a.join('\n'),b.join('\n')),actual=[...a];for(const e of [...diff.edits].reverse())actual.splice(e.oldStart,e.oldEnd-e.oldStart,...e.afterLines);assert.equal(actual.join('\n'),b.join('\n'));}
 const a=Array.from({length:1200},(_,i)=>i%20===0?'section '+i:'  }'),b=[...a];b[101]='changed one';b[901]='changed two';const input=candidateInput({path:'large.tsx',before:a.join('\n'),after:b.join('\n')},'v');assert.equal(input.coverageComplete,true);assert.equal(input.change.ranges.length,2);assert.ok(input.candidate_context.length<2000);
});
test('同文件两个会话改不同段，仅审各自范围',async()=>{
 const f=fixture(),a=session(f),b=session(f),path=join(f.cwd,'shared.ts'),original=document();writeFileSync(path,original.join('\n'));const first=[...original];first[2]='A';write(a,path,first.join('\n'));const second=[...first];second[30]='B';write(b,path,second.join('\n'));
 await Promise.all([a.c.finalAudit(a.ctx),b.c.finalAudit(b.ctx)]);assert.deepEqual(a.seen[0].change.ranges,[{startLine:3,endLine:3}]);assert.deepEqual(b.seen[0].change.ranges,[{startLine:31,endLine:31}]);assert.equal(a.seen[0].change.after,'A');assert.equal(b.seen[0].change.after,'B');
});
test('外部在前方插入行，原会话行号随内容移动',async()=>{
 const f=fixture(),s=session(f),path=join(f.cwd,'shared.ts'),original=document();writeFileSync(path,original.join('\n'));original[20]='own';write(s,path,original.join('\n'));writeFileSync(path,['external',...original].join('\n'));await s.c.finalAudit(s.ctx);assert.deepEqual(s.seen[0].change.ranges,[{startLine:22,endLine:22}]);assert.equal(s.seen[0].change.after,'own');
});
test('外部修改远离上下文时，原行段检查缓存仍复用',async()=>{
 const f=fixture(),s=session(f),path=join(f.cwd,'shared.ts'),original=document();writeFileSync(path,original.join('\n'));original[2]='own';write(s,path,original.join('\n'));await s.c.finalAudit(s.ctx);original[30]='external';writeFileSync(path,original.join('\n'));assert.equal((await s.c.finalAudit(s.ctx))[0].cacheReused,true);assert.equal(s.seen.length,1);
});
test('同轮交错改两段，背景中的其他会话改动不进入范围',async()=>{
 const f=fixture(),s=session(f),path=join(f.cwd,'shared.ts'),original=document();writeFileSync(path,original.join('\n'));original[2]='own one';write(s,path,original.join('\n'));original[30]='external';writeFileSync(path,original.join('\n'));original[20]='own two';write(s,path,original.join('\n'));await s.c.finalAudit(s.ctx);assert.deepEqual(s.seen[0].change.ranges,[{startLine:3,endLine:3},{startLine:21,endLine:21}]);assert.equal(s.seen[0].change.after.includes('external'),false);
});
test('删除行的归属在前方新增行后仍定位到正确空隙',()=>{
 const r=rebaseOwned('a\nb\nc','a\nc','external\na\nc');assert.equal(r.conflicts.length,0);assert.equal(r.before,'external\na\nb\nc');assert.deepEqual(candidateInput({path:'x.ts',before:r.before,after:r.after},'v').change.ranges,[{startLine:3,endLine:2}]);
});
test('超过一次范围的多个完整段拆分检查，每段不截断且缓存复用',async()=>{
 const f=fixture(),s=session(f),path=join(f.cwd,'large.ts'),a=Array.from({length:700},(_,i)=>String(i).padStart(4,'0')+' '+'.'.repeat(100)),b=[...a];for(let i=40;i<160;i++)b[i]='first '+i+' '+':'.repeat(100);for(let i=500;i<620;i++)b[i]='second '+i+' '+':'.repeat(100);writeFileSync(path,a.join('\n'));write(s,path,b.join('\n'));assert.equal(partitionChange({path,before:a.join('\n'),after:b.join('\n')}).length,2);const results=await s.c.finalAudit(s.ctx);assert.equal(results.length,2);assert.ok(results.every(r=>r.payload.coverageComplete));assert.equal(s.seen.length,2);await s.c.finalAudit(s.ctx);assert.equal(s.seen.length,2);
});
test('候选补丁不能改只读上下文里的其他行',()=>{
 const p=candidateInput({path:'x.ts',before:'a\nb\nc',after:'a\nB\nc'},'v');p.rules=[{id:'rule'}];p.evidence=[{id:'CANDIDATE'}];assert.throws(()=>validateReview({verdict:'reject',findings:[{ruleId:'rule',location:'x.ts:2',problem:'problem',suggestion:'fix',evidenceRefs:['CANDIDATE']}],neededEvidence:[],patches:[{candidateVersion:'v',ruleId:'rule',startLine:1,endLine:1,newText:'other'}]},p),/实际修改的行段/);
});
test('重叠冲突回读后修正，保留另一自有段与外部段并闭环',async()=>{
 const f=fixture(),s=session(f),path=join(f.cwd,'shared.ts'),a=document();writeFileSync(path,a.join('\n'));a[2]='own conflict';a[20]='own other';write(s,path,a.join('\n'));a[2]='external conflict';a[30]='external other';writeFileSync(path,a.join('\n'));
 const conflict=(await s.c.finalAudit(s.ctx))[0];assert.equal(conflict.stale,true);assert.ok(conflict.recovery);capture(s,path,1,10);a[2]='merged final';write(s,path,a.join('\n'));const result=(await s.c.finalAudit(s.ctx))[0];assert.equal(result.review.verdict,'allow');assert.deepEqual(result.ranges,[{startLine:3,endLine:3},{startLine:21,endLine:21}]);assert.equal(s.c.status().files[0].conflicts.length,0);assert.equal(s.c.status().files[0].resolutions[0].decision,'rewrite_latest');assert.equal(s.seen[0].change.after.includes('external other'),false);
});
test('重叠结果回读后直接复核，无需提交路径和读取版本',async()=>{
 const f=fixture(),s=session(f),path=join(f.cwd,'shared.ts'),a=document();writeFileSync(path,a.join('\n'));a[2]='own';write(s,path,a.join('\n'));a[2]='combined latest';writeFileSync(path,a.join('\n'));assert.ok((await s.c.finalAudit(s.ctx))[0].recovery);capture(s,path,3,3);
 const result=(await s.c.finalAudit(s.ctx))[0];assert.equal(result.review.verdict,'allow');assert.equal(s.seen[0].change.after,'combined latest');assert.equal(s.c.status().files[0].conflicts.length,0);assert.equal(s.c.status().files[0].resolutions[0].decision,'read_latest');
});
test('未回读、读后再变及无关文件读取只返回待处理，不抛恢复异常',async()=>{
 const f=fixture(),s=session(f),path=join(f.cwd,'shared.ts');writeFileSync(path,'baseline');write(s,path,'own');writeFileSync(path,'other');assert.ok((await s.c.finalAudit(s.ctx))[0].recovery);assert.equal(s.seen.length,0);capture(s,path);writeFileSync(path,'newer');assert.ok((await s.c.finalAudit(s.ctx))[0].recovery);const outsider=join(f.cwd,'other.ts');writeFileSync(outsider,'outside');capture(s,outsider);const result=(await s.c.finalAudit(s.ctx))[0];assert.equal(result.status,'unchecked');assert.ok(result.recovery);assert.equal(s.seen.length,0);
});
