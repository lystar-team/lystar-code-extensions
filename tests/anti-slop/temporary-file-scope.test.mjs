import './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,unlinkSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {createReviewController,deliveryDecision} from '../../extensions/lystar-jev-anti-slop/anti-slop.mjs';

function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'slop-temporary-scope-')),cwd=join(root,'project');mkdirSync(cwd);
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const seen=[],ctx={cwd,reviewLogPath:join(root,'audit.jsonl'),sessionManager:{getBranch:()=>[]}};
 const c=createReviewController({}, {ask:async p=>{seen.push(p);return {review:{verdict:'allow',findings:[],neededEvidence:[],patches:[]}};}});
 return {root,cwd,ctx,c,seen};
}
function record(f,path,after){
 let before='';try{before=readFileSync(path,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
 writeFileSync(path,after);f.c.written(path,before,after,{status:'pending'});
}

test('四个项目文件通过，三个已删除的外部临时脚本不产生冲突',async t=>{
 const f=fixture(t),projectPaths=[],temporaryPaths=[];
 for(let i=0;i<4;i++){const path=join(f.cwd,'project-'+i+'.ts');record(f,path,'工程协议候选');projectPaths.push(path);}
 for(let i=0;i<3;i++){const path=join(f.root,'verification-'+i+'.ts');record(f,path,'临时核验脚本');unlinkSync(path);temporaryPaths.push(path);}
 const result=await f.c.finalAudit(f.ctx);
 assert.deepEqual(result.map(r=>r.path),projectPaths);assert.equal(deliveryDecision(result).nextAction,'finish');
 assert.equal(result.audit.fileCount,4);assert.equal(result.audit.modelRequests,4);
 assert.deepEqual(result.audit.excludedFiles.map(e=>e.path),temporaryPaths);
 assert.equal(f.c.status().trackedFiles.some(path=>temporaryPaths.includes(path)),false);
 assert.equal(f.c.status().latest.some(r=>temporaryPaths.includes(r.path)),false);
 const repeated=await f.c.finalAudit(f.ctx);assert.equal(deliveryDecision(repeated).canFinish,true);assert.equal(repeated.audit.modelRequests,0);assert.equal(f.seen.length,4);
});

test('写入代理将外部临时文件标为排除，删除后不送模型也不报通过',async t=>{
 const f=fixture(t),path=join(f.root,'verification.ts');await f.c.start(f.ctx);
 const token=f.c.beginEdit(path,{callId:'temporary-write',tool:'write'});
 const report=await f.c.beforeWrite(path,'','临时脚本',f.ctx);assert.equal(report.status,'excluded');assert.equal(report.skip,'external-temporary-file');
 writeFileSync(path,'临时脚本');f.c.written(path,'','临时脚本',report,token);f.c.endEdit(token);unlinkSync(path);
 const result=await f.c.finalAudit(f.ctx);assert.equal(result.length,0);assert.equal(result.audit.modelRequests,0);assert.equal(result.audit.excludedFiles.length,1);
 assert.equal(deliveryDecision(result).state,'no_changes');assert.equal(result.audit.decision.canFinish,true);assert.match(result.audit.decision.reason,/已排除/);
 const status=f.c.status();assert.deepEqual(status.trackedFiles,[]);assert.equal(status.files[0].status,'excluded');assert.equal(status.files[0].writes,1);assert.equal(status.files[0].calls[0].outcome,'written');assert.equal(f.seen.length,0);
});

test('目录外临时文件直接请求复核或指定路径时仍排除',async t=>{
 const f=fixture(t),path=join(f.root,'verification.ts');
 const direct=await f.c.review({path,before:'',after:'临时脚本'},f.ctx);assert.equal(direct.status,'excluded');assert.equal(direct.review,undefined);
 const result=await f.c.finalAudit(f.ctx,[path]);assert.equal(result.length,0);assert.equal(result.audit.decision.nextAction,'finish');assert.equal(result.audit.excludedFiles[0].path,path);assert.equal(f.seen.length,0);
 // 原本的显式空范围仍未检查，不能因排除逻辑而放行。
 const empty=await f.c.finalAudit(f.ctx,[]);assert.equal(empty[0].status,'unchecked');
});

test('工作目录本身位于tmp时仍审查目录内文件，不按文件名跳过',async t=>{
 const f=fixture(t),dir=join(f.cwd,'tmp');mkdirSync(dir);
 const paths=[join(f.cwd,'verification.ts'),join(dir,'temporary.ts')];
 for(const path of paths){assert.equal((await f.c.beforeWrite(path,'','目录内候选',f.ctx)).status,'pending');record(f,path,'目录内候选');}
 const result=await f.c.finalAudit(f.ctx);assert.deepEqual(result.map(r=>r.path),paths);assert.equal(f.seen.length,2);assert.deepEqual(result.audit.excludedFiles,[]);
});

test('目录内文件被外部删除时仍保留冲突，不能借临时文件排除放行',async t=>{
 const f=fixture(t),path=join(f.cwd,'verification.ts');record(f,path,'项目候选');unlinkSync(path);
 const result=await f.c.finalAudit(f.ctx);assert.equal(result[0].stale,true);assert.equal(deliveryDecision(result).canFinish,false);assert.deepEqual(result.audit.excludedFiles,[]);
});

test('目录外正式文件保留审查，工作目录相似前缀不能算目录内',async t=>{
 const f=fixture(t),formal=join(homedir(),'shared-formal-scope.ts');
 assert.equal((await f.c.beforeWrite(formal,'before','after',f.ctx)).status,'pending');
 assert.equal((await f.c.review({path:formal,before:'before',after:'after'},f.ctx)).review.verdict,'allow');assert.equal(f.seen.length,1);
 const sibling=join(f.root,'project-extra');mkdirSync(sibling);assert.equal((await f.c.beforeWrite(join(sibling,'verification.ts'),'','candidate',f.ctx)).status,'excluded');
});

test('工作目录内的符号链接文件仍审查，真实路径归并不导致错误排除',async t=>{
 const f=fixture(t),outside=join(f.root,'shared'),alias=join(f.cwd,'linked');mkdirSync(outside);symlinkSync(outside,alias,process.platform==='win32'?'junction':'dir');
 const logical=join(alias,'module.ts'),physical=join(outside,'module.ts'),token=f.c.beginEdit(logical,{callId:'project-link',tool:'write'});
 const report=await f.c.beforeWrite(logical,'','项目链接候选',f.ctx);assert.equal(report.status,'pending');
 writeFileSync(logical,'项目链接候选');f.c.written(logical,'','项目链接候选',report,token);f.c.endEdit(token);
 const result=await f.c.finalAudit(f.ctx,[logical,physical]);assert.equal(result.length,1);assert.equal(result[0].path,physical);assert.equal(result[0].review.verdict,'allow');assert.deepEqual(result.audit.excludedFiles,[]);assert.equal(f.seen.length,1);
});

test('不等待目录外临时文件的在途写入，保留项目文件复核',async t=>{
 const f=fixture(t),path=join(f.cwd,'module.ts');record(f,path,'项目候选');await f.c.start(f.ctx);
 const token=f.c.beginEdit(join(f.root,'verification.ts'),{callId:'ongoing-temporary',tool:'write'});
 try{const result=await f.c.finalAudit(f.ctx);assert.equal(result[0].review.verdict,'allow');assert.equal(result.audit.excludedFiles.length,1);assert.equal(f.seen.length,1);}
 finally{f.c.endEdit(token,{failed:true});}
});
