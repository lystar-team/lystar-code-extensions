import './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {formatAuditOutput,createReviewController} from '../../extensions/lystar-jev-anti-slop/anti-slop.mjs';

const allow=()=>({verdict:'allow',findings:[],neededEvidence:[],patches:[]});
const finding={ruleId:'unsupported-fallback',location:'changed.ts:2',problem:'掩盖接口错误',suggestion:'保留接口规定的失败行为',evidenceRefs:['E1']};
function audit(results,extra={}){
 Object.defineProperty(results,'audit',{value:{fileCount:new Set(results.map(r=>r.path).filter(Boolean)).size,logPath:'/logs/review.jsonl',excludedFiles:[],...extra}});return results;
}
function noDiagnostics(output){
 const text=JSON.stringify(output);
 for(const field of ['ranges','readRanges','recovery','patches','pendingItems','omittedEvidence','diagnostics','logPath','scopeDiagnostics','requestId'])assert.equal(text.includes('"'+field+'"'),false,field);
}

test('全部通过只返回简短判定，不随文件数展开日志与空字段',()=>{
 const results=audit(Array.from({length:7},(_,i)=>({path:'/project/file-'+i+'.ts',status:'checked',review:allow(),ranges:[{startLine:1,endLine:2}],requestId:'request-'+i,payload:{rules:['规则'],omittedEvidence:[{path:'unrelated',reason:'budget'}]}})));
 const output=formatAuditOutput(results);
 assert.deepEqual(output,{status:'clear',decision:{canFinish:true,nextAction:'finish'},fileCount:7});
 assert.ok(JSON.stringify(output).length<120);assert.ok(results[0].payload);noDiagnostics(output);
});

test('混合结果只列出未完成原因，不输出内部范围和请求日志',()=>{
 const output=formatAuditOutput(audit([{path:'passed.ts',status:'checked',review:allow()},{path:'failed.ts',status:'unchecked',error:'读取失败',failureReason:'source_read_error',ranges:[{startLine:8,endLine:40}],requestId:'request'}]));
 assert.equal(output.decision.nextAction,'report_unchecked');assert.equal(output.decision.canFinish,false);
 assert.deepEqual(output.results,[{path:'failed.ts',feedback:'读取失败'}]);assert.equal(output.fileCount,2);noDiagnostics(output);
});

test('违规返回位置、问题和修正要求，不返回补丁全文或重复问题清单',()=>{
 const output=formatAuditOutput(audit([{path:'changed.ts',status:'checked',review:{verdict:'reject',findings:[finding],neededEvidence:[],patches:[{newText:'重复源码'}]},pendingItems:[{id:'finding-1',finding}],payload:{evidence:[{id:'E1',path:'接口契约'}]}}]));
 assert.equal(output.decision.nextAction,'fix_reported_items');
 for(const text of [finding.location,finding.problem,finding.suggestion])assert.ok(output.results[0].feedback.includes(text));
 assert.equal(JSON.stringify(output).includes('重复源码'),false);noDiagnostics(output);
});

test('待补证只返回所需材料，不展开不相关的省略证据列表',()=>{
 const output=formatAuditOutput(audit([{path:'changed.ts',status:'checked',review:{verdict:'needs_evidence',findings:[],neededEvidence:['读取 api.ts 的真实接口定义'],patches:[]},payload:{omittedEvidence:[{path:'api.ts',reason:'partial'},{path:'unrelated',reason:'budget'}]}}]));
 assert.equal(output.decision.nextAction,'supply_requested_evidence');assert.match(output.results[0].feedback,/api.ts/);noDiagnostics(output);
});

test('冲突只返回可执行的回读位置与合并要求',()=>{
 const recovery={ranges:[{startLine:5,endLine:5}],readRanges:[{startLine:2,endLine:8}],instruction:'回读最新行段并合并'};
 const output=formatAuditOutput(audit([{path:'shared.ts',status:'unchecked',error:'重叠修改待恢复',ranges:recovery.ranges,recovery}]));
 assert.equal(output.decision.nextAction,'read_and_merge');assert.match(output.results[0].feedback,/shared.ts:2-8/);assert.match(output.results[0].feedback,/合并/);noDiagnostics(output);
});

test('停止确认时反馈原问题，不暴露内部ID和确认数组',()=>{
 const pendingItems=[{id:'candidate-1-finding-1',kind:'finding',finding},{id:'candidate-1-evidence-1',kind:'evidence',requirement:'真实契约'}];
 const output=formatAuditOutput(audit([{path:'changed.ts',status:'unchecked',stopRequested:true,error:'两次确认仍未收敛',pendingItems}]));
 assert.equal(output.decision.nextAction,'report_remaining');assert.equal(output.decision.canFinish,false);
 assert.match(output.results[0].feedback,/真实契约/);assert.ok(output.results[0].feedback.includes(finding.problem));noDiagnostics(output);
});

test('无修改和仅有排除文件均不宣称通过',()=>{
 assert.deepEqual(formatAuditOutput([]),{status:'no_recorded_changes',decision:{canFinish:true,nextAction:'finish'},fileCount:0});
 const output=formatAuditOutput(audit([],{excludedFiles:[{path:'/tmp/check.ts',reason:'external-temporary-file'}]}));
 assert.equal(output.status,'no_recorded_changes');assert.equal(output.excludedFileCount,1);assert.equal(JSON.stringify(output).includes('/tmp/check.ts'),false);
});

test('缺少轮次标识返回简短未检查原因',()=>{
 const output=formatAuditOutput([{status:'unchecked',failureReason:'missing_input_id',error:'缺少当前输入轮次标识'}]);
 assert.equal(output.decision.canFinish,false);assert.match(output.results[0].feedback,/轮次标识/);noDiagnostics(output);
});

test('证据省略详情只留在显式状态查询中',async()=>{
 const c=createReviewController({}, {ask:async()=>({review:allow(),metrics:{simulation:true}})});
 await c.review({path:'/project/changed.ts',before:'before',after:'after'},{cwd:'/project'},{extraEvidence:[{id:'E1',path:'contract.md',text:'a'.repeat(30000)}]});
 const omitted=c.status().latest[0].omittedEvidence;assert.equal(omitted[0].path,'contract.md');assert.equal(omitted[0].reason,'partial');assert.ok(omitted[0].sentChars<30000);
});
