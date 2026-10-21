import './setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sourceLocations,confirmationContext,findingWithinRanges} from '../../extensions/lystar-jev-anti-slop/review-convergence.mjs';
import {createReviewController,deliveryDecision,formatAuditOutput} from '../../extensions/lystar-jev-anti-slop/anti-slop.mjs';

const allow=()=>({verdict:'allow',findings:[],neededEvidence:[],patches:[]});
const finding=location=>({ruleId:'design-spec-compliance',location,problem:'主操作的颜色不符合本轮品牌要求',suggestion:'按品牌要求修正所有主操作颜色',evidenceRefs:['CANDIDATE']});
function resolved(p){return {...allow(),checks:p.reviewContext.items.map(i=>({id:i.id,state:'resolved',reason:'全部关联位置的最新内容已符合原要求',evidenceRefs:['CANDIDATE']})),findingSources:[]};}
function unresolved(p){return {verdict:'reject',findings:p.reviewContext.items.map(i=>i.finding),neededEvidence:[],patches:[],checks:p.reviewContext.items.map(i=>({id:i.id,state:'unresolved',reason:'关联位置仍存在原问题',evidenceRefs:['CANDIDATE']})),findingSources:p.reviewContext.items.map((i,findingIndex)=>({findingIndex,checkId:i.id,correctionIndex:-1,beforeSnippet:'',afterSnippet:'',reason:'原问题仍存在'}))};}
function fixture(t,ask){
 const cwd=mkdtempSync(join(tmpdir(),'slop-location-')),path=join(cwd,'design.md'),ctx={cwd,reviewLogPath:join(cwd,'review.jsonl')},seen=[];
 t.after(()=>rmSync(cwd,{recursive:true,force:true}));
 const c=createReviewController({}, {ask:async p=>{seen.push(p);return {review:await ask(p,seen.length),metrics:{simulation:true}};}});
 return {c,path,ctx,seen,write(text){let before='';try{before=readFileSync(path,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}writeFileSync(path,text);c.written(path,before,text,{status:'pending'});},audit(){return c.finalAudit(ctx);}};
}
const lines=()=>Array.from({length:80},(_,i)=>'正文 '+(i+1));

for(const [location,expected] of [
 ['design.md:25,65,71',[[25,1,25],[65,1,65],[71,1,71]]],
 ['design.md:25， 65、71',[[25,1,25],[65,1,65],[71,1,71]]],
 ['design.md:25-27,65',[[25,1,27],[65,1,65]]],
 ['design.md:25:3-27:9,65:12',[[25,3,27],[65,12,65]]],
 ['C:\\workspace\\design.md:25:3',[[25,3,25]]]
])test('位置解析：'+location,()=>assert.deepEqual(sourceLocations(location).map(p=>[p.line,p.column,p.endLine]),expected));

test('无行号和无效坐标不伪造位置',()=>{
 for(const location of ['design.md §配色','design.md:0','design.md:25-2','design.md:25:9-25:2','design.md:25,,65'])assert.deepEqual(sourceLocations(location),[]);
});

test('重放日志中的design.md:25,65,71，确认包含三处最新内容并保留一个问题ID',async t=>{
 const f=fixture(t,(p,count)=>count===1?{verdict:'reject',findings:[finding('design.md:25,65,71')],neededEvidence:[],patches:[]}:resolved(p));
 const rows=lines();for(const line of [25,65,71])rows[line-1]='主操作颜色：黑色 '+line;
 f.write(rows.join('\n'));const first=await f.audit(),id=first[0].pendingItems[0].id;assert.equal(deliveryDecision(first).nextAction,'fix_reported_items');
 for(const line of [25,65,71])rows[line-1]='主操作颜色：品牌蓝 '+line;
 f.write(rows.join('\n'));const final=await f.audit();assert.equal(deliveryDecision(final).nextAction,'finish');
 assert.equal(f.seen[1].reviewContext.items.length,1);assert.equal(f.seen[1].reviewContext.items[0].id,id);
 for(const line of [25,65,71])assert.ok(f.seen[1].reviewContext.confirmation_context.includes(`${line}| 主操作颜色：品牌蓝 ${line}`));
 await f.audit();assert.equal(f.seen.length,2);
});

test('多位置在前方插入和局部删除后分别重定位，未解决时继续保留原问题',async t=>{
 const f=fixture(t,(p,count)=>count===1?{verdict:'reject',findings:[finding('design.md:25,65,71')],neededEvidence:[],patches:[]}:unresolved(p));
 const rows=lines();rows[70]='仍有问题的颜色';f.write(rows.join('\n'));const first=await f.audit(),id=first[0].pendingItems[0].id;
 rows.splice(64,1);rows.unshift('插入说明一','插入说明二');f.write(rows.join('\n'));const final=await f.audit();
 assert.equal(final[0].status,'checked');assert.equal(final[0].review.verdict,'reject');assert.equal(final[0].pendingItems[0].id,id);
 assert.equal(f.seen[1].reviewContext.items[0].finding.location,'design.md:27,67,72');assert.match(f.seen[1].reviewContext.confirmation_context,/72\| 仍有问题的颜色/);assert.equal(deliveryDecision(final).canFinish,false);
});

test('行号范围的中间内容也进入确认材料',async t=>{
 const f=fixture(t,(p,count)=>count===1?{verdict:'reject',findings:[finding('design.md:25-35,65')],neededEvidence:[],patches:[]}:resolved(p));
 const rows=lines();f.write(rows.join('\n'));await f.audit();rows[29]='范围中间的实际修正';f.write(rows.join('\n'));
 assert.equal(deliveryDecision(await f.audit()).canFinish,true);for(let line=25;line<=35;line++)assert.ok(f.seen[1].reviewContext.confirmation_context.includes(line+'| '));
 assert.match(f.seen[1].reviewContext.confirmation_context,/30\| 范围中间的实际修正/);
});

test('只有章节名称时按原审查行段确认，不把其他正文纳入材料或伪造行号',async t=>{
 const f=fixture(t,(p,count)=>count===1?{verdict:'reject',findings:[finding('design.md §配色')],neededEvidence:[],patches:[]}:resolved(p));
 const rows=lines();rows[40]='不在本轮改动中的独立正文';writeFileSync(f.path,rows.join('\n'));
 rows[24]='主操作颜色：黑色';rows[70]='填充颜色：黑色';f.write(rows.join('\n'));const first=await f.audit(),id=first[0].pendingItems[0].id;
 assert.deepEqual(first[0].pendingItems[0].scope,[{startLine:25,endLine:25},{startLine:71,endLine:71}]);
 rows[24]='主操作颜色：品牌蓝';rows[70]='填充颜色：品牌蓝';f.write(rows.join('\n'));
 const final=await f.audit();assert.equal(deliveryDecision(final).canFinish,true);const item=f.seen[1].reviewContext.items[0];assert.equal(item.id,id);assert.equal(item.finding.location,'design.md §配色');
 assert.match(f.seen[1].reviewContext.confirmation_context,/25\| 主操作颜色：品牌蓝/);assert.match(f.seen[1].reviewContext.confirmation_context,/71\| 填充颜色：品牌蓝/);
 assert.equal(f.seen[1].reviewContext.confirmation_context.includes('独立正文'),false);
 const text=JSON.stringify(formatAuditOutput(final));assert.equal(text.includes('scope'),false);assert.equal(text.includes('ranges'),false);
});

test('旧问题记录无内部scope时仍可以使用已保存的原审查范围',()=>{
 const after='正文\n旧颜色\n其他正文',previous={after,pendingItems:[{id:'old-finding',kind:'finding',finding:finding('design.md §配色')}],result:{payload:{change:{ranges:[{startLine:2,endLine:2}]}},review:{...allow(),findings:[finding('design.md §配色')]}}};
 const context=confirmationContext(previous,{path:'design.md',before:'',after:'正文\n品牌蓝\n其他正文'},[{startLine:2,endLine:2}]);
 assert.match(context.confirmation_context,/2\| 品牌蓝/);assert.equal(context.confirmation_context.includes('其他正文'),false);assert.equal(context.items[0].id,'old-finding');
});

test('只有章节名称的长行问题按已审查的字符范围确认',async t=>{
 const f=fixture(t,(p,count)=>p.reviewContext?p.reviewContext.mode==='verify'?resolved(p):allow():count===2?{verdict:'reject',findings:[finding('design.md §颜色配置')],neededEvidence:[],patches:[]}:allow());
 f.write('a'.repeat(40000));const first=await f.audit(),rejected=first.find(r=>r.review.verdict==='reject'),scope=rejected.pendingItems[0].scope[0];
 const index=scope.startColumn+100;f.write('a'.repeat(index)+'b'+'a'.repeat(39999-index));assert.equal(deliveryDecision(await f.audit()).canFinish,true);
 const verify=f.seen.find(p=>p.reviewContext?.mode==='verify');assert.ok(verify.reviewContext.confirmation_context.includes('b'));assert.ok(verify.reviewContext.confirmation_context.length<12000);
 assert.ok(verify.reviewContext.confirmation_context.startsWith('1:'+scope.startColumn+'| '));
});

test('多位置包含未改行时不能只验证第一处后当成合法新增问题',()=>{
 assert.equal(findingWithinRanges('design.md:25,65,71',[{startLine:25,endLine:25},{startLine:65,endLine:65}]),false);
 assert.equal(findingWithinRanges('design.md:25-27,65',[{startLine:25,endLine:27},{startLine:65,endLine:65}]),true);
});

test('同一问题关联位置位于其他分片时，外部位置修改使旧确认缓存失效',async t=>{
 const f=fixture(t,(p,count)=>p.reviewContext?.mode==='verify'?unresolved(p):p.reviewContext?allow():count===1?{verdict:'reject',findings:[finding('design.md:25,650')],neededEvidence:[],patches:[]}:allow());
 const rows=Array.from({length:800},(_,i)=>'颜色 '+(i+1)+' '+'.'.repeat(90));f.write(rows.join('\n'));await f.audit();
 rows[649]='颜色 650：第一次修正';f.write(rows.join('\n'));await f.audit();const verifyCount=()=>f.seen.filter(p=>p.reviewContext?.mode==='verify').length;assert.equal(verifyCount(),1);
 rows[649]='颜色 650：第二次修正';f.write(rows.join('\n'));const final=await f.audit();assert.equal(verifyCount(),2);assert.equal(deliveryDecision(final).nextAction,'report_remaining');
});
