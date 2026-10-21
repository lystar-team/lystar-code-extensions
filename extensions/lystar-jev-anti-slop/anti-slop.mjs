import { readFileSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { homedir,tmpdir } from 'node:os';
import { basename, dirname, join, resolve, relative, sep, isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { createHash,randomUUID } from 'node:crypto';
import {requestReview,REVIEW_SCHEMA,writeAuditLog,requestEnvelopeChars,REQUEST_LIMIT} from './review-client.mjs';
import {candidateInput,diffHunks,rebaseOwned,partitionChange,CONTEXT_LIMIT} from './line-ranges.mjs';
import {confirmationItems,confirmationContext,reviewPlan,findingWithinRanges,remainingItems,validateConfirmation,deliveryDecision,MAX_FIX_CONFIRMATIONS} from './review-convergence.mjs';
import {selectEvidence,evidenceCurrent,evidenceDependencies,evidencePayload,materialVersion} from './review-evidence.mjs';
export {deliveryDecision};
export {candidateInput,diffHunks};
export const RULES_PATH = join(homedir(), '.agents/skills/anti-ai-slop/rules.json');
const exec = promisify(execFile);
function isText(text){return !/[\u0000-\u0008\u000b\u000e-\u001f]/.test(text);}
export function decodeSource(bytes){
  try{const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);return isText(text)?text:undefined;}catch{return undefined;}
}

function strings(value, field, empty = false) {
  if (!Array.isArray(value) || (!empty && !value.length) || value.some(item => typeof item !== 'string' || !item.trim())) throw new Error(`${field} 必须是字符串数组`);
}
export function validateConfig(config) {
  if (config.version !== 2 || !Array.isArray(config.rules)) throw new Error('规则需要 version:2 和 rules 数组');
  const r = config.reviewer;
  if (!r || !['provider','model','thinkingLevel'].every(key => typeof r[key] === 'string' && r[key].trim())) throw new Error('缺少审查模型配置');
  if (!['off','minimal','low','medium','high','xhigh','max'].includes(r.thinkingLevel)) throw new Error('未知 thinkingLevel');
  for (const key of ['timeoutMs','maxOutputTokens']) {
    if (!Number.isInteger(r[key]) || r[key] < 1) throw new Error(`无效 ${key}`);
  }
  const ids = new Set();
  for (const rule of config.rules) {
    if (typeof rule.id!=='string' || !rule.id.trim() || ids.has(rule.id)) throw new Error('规则 ID 缺失或重复');
    ids.add(rule.id);
    if (typeof rule.enabled !== 'boolean' || !['review','block'].includes(rule.action)) throw new Error(`${rule.id}：无效 enabled/action`);
    for (const field of ['title','scope','violation']) if (typeof rule[field] !== 'string' || !rule[field].trim()) throw new Error(`${rule.id}：缺少 ${field}`);
    strings(rule.scenarios,'scenarios');
    if(rule.scenarios.some(s=>!['前端','后端','文档文案','通用'].includes(s)))throw new Error(`${rule.id}：未知适用场景`);
    strings(rule.requiredEvidence, 'requiredEvidence'); strings(rule.exceptions, 'exceptions', true); strings(rule.checkAt, 'checkAt');
    if (rule.checkAt.some(stage => !['write','settle'].includes(stage))) throw new Error('无效检查边界');
    for (const key of ['bad','good']) if (typeof rule[key]?.context !== 'string' || typeof rule[key]?.artifact !== 'string') throw new Error(`${rule.id}：缺少正反例`);
  }
  return config;
}
export function loadConfig(path = RULES_PATH) {
  const raw = readFileSync(path, 'utf8');
  return { config: validateConfig(JSON.parse(raw)), raw };
}
export function loadRules(path = RULES_PATH) { return loadConfig(path).config.rules.filter(rule => rule.enabled); }
export function readSource(path) {
  try {
    return decodeSource(readFileSync(path));
  } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
export function canonical(path) {
  path=resolve(path);
  try{return realpathSync(path);}catch{const parent=dirname(path);return parent===path?path:join(canonical(parent),basename(path));}
}
function withinDirectory(path,root){
  const child=relative(root,path);
  return child===''||!isAbsolute(child)&&child!=='..'&&!child.startsWith('..'+sep);
}
function isExternalTemporaryFile(path,cwd){
  if(!cwd)return false;
  const absolute=resolve(cwd,path),physical=canonical(absolute);
  if(withinDirectory(absolute,resolve(cwd))||withinDirectory(physical,canonical(cwd)))return false;
  const roots=process.platform==='win32'?[tmpdir()]:[tmpdir(),'/tmp','/var/tmp'];
  return roots.some(root=>withinDirectory(physical,canonical(root)));
}

function keys(value, allowed) { if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(k=>!allowed.includes(k))) throw new Error('返回结构包含未知字段'); }
export function validateReview(review, payload) {
  keys(review,['verdict','findings','neededEvidence','patches']);
  if(!['allow','reject','needs_evidence'].includes(review.verdict) || !Array.isArray(review.findings) || !Array.isArray(review.patches)) throw new Error('无效审查结论');
  strings(review.neededEvidence,'neededEvidence',true);
  if(review.patches.length>4) throw new Error('返回补丁过多；其余确定问题仍须完整列出');
  if(review.verdict==='allow' && (review.findings.length || review.neededEvidence.length || review.patches.length)) throw new Error('allow 与问题/补证/补丁冲突');
  if(review.verdict==='reject' && !review.findings.length) throw new Error('reject 缺少问题');
  if(review.verdict==='needs_evidence' && (!review.neededEvidence.length || review.patches.length)) throw new Error('needs_evidence 缺材料或包含无依据补丁');
  if(review.verdict!=='needs_evidence' && review.neededEvidence.length) throw new Error('结论与补证状态冲突');
  const rules=new Set(payload.rules.map(r=>r.id)), refs=new Set(payload.evidence.map(e=>e.id));
  for(const finding of review.findings) {
    keys(finding,['ruleId','location','problem','evidenceRefs','suggestion']);
    if(!rules.has(finding.ruleId) || !['location','problem','suggestion'].every(k=>typeof finding[k]==='string'&&finding[k].trim())) throw new Error('无效问题或规则引用');
    strings(finding.evidenceRefs,'evidenceRefs');
    if(finding.evidenceRefs.some(id=>!refs.has(id))) throw new Error('未知证据引用');
  }
  for(const patch of review.patches) {
    if(payload.candidate.partialLines)throw new Error('分片候选不能提供整行替换补丁');
    keys(patch,['candidateVersion','ruleId','startLine','endLine','newText']);
    if(review.verdict!=='reject' || patch.candidateVersion!==payload.candidate.version || !review.findings.some(f=>f.ruleId===patch.ruleId)) throw new Error('补丁版本或问题归属无效');
    if(!Number.isInteger(patch.startLine)||!Number.isInteger(patch.endLine)||patch.startLine<1||patch.endLine<patch.startLine-1||patch.endLine>payload.candidate.lineCount||typeof patch.newText!=='string') throw new Error('无效补丁行范围');
    if(!payload.candidate.visibleRanges.some(r=>patch.startLine>=r.startLine&&patch.endLine<=r.endLine)) throw new Error('补丁引用了未提供的源码范围');
    if(!payload.change.ranges.some(r=>patch.startLine>=r.startLine&&patch.endLine<=r.endLine)) throw new Error('补丁超出当前会话本轮实际修改的行段');
  }
  const ordered=[...review.patches].sort((a,b)=>a.startLine-b.startLine);
  for(let i=1;i<ordered.length;i++) if(ordered[i].startLine<=Math.max(ordered[i-1].startLine,ordered[i-1].endLine)) throw new Error('补丁范围重叠');
  return review;
}
async function git(cwd,args) { return (await exec('git',['-C',cwd,...args],{encoding:'utf8',timeout:5000,maxBuffer:4*1024*1024})).stdout; }
export async function captureWorkspaceBaseline(cwd) {
  const roots=new Set(), notes=[];
  try { roots.add((await git(cwd,['rev-parse','--show-toplevel'])).trim()); } catch {
    for(const item of readdirSync(cwd,{withFileTypes:true})) if(item.isDirectory()) {
      try { statSync(join(cwd,item.name,'.git'));roots.add(join(cwd,item.name)); } catch {}
    }
  }
  const snapshots=[];
  for(const root of roots) {
    const initial=new Map();
    try {
      const paths=(await git(root,['-c','status.renames=false','status','--porcelain=v1','-z','--untracked-files=all'])).split('\0').filter(Boolean).map(s=>s.slice(3));
      for(const path of paths) { const full=canonical(resolve(root,path));const content=readSource(full);if(content!==undefined)initial.set(full,content); }
      snapshots.push({root,initial});
    } catch(error) { notes.push(`${root}：基线未取得，${error.message}`); }
  }
  return {snapshots,notes};
}
export async function collectFinalChanges(baseline,tracked) {
  const result=new Map();
  for(const snapshot of baseline.snapshots) {
    const paths=(await git(snapshot.root,['-c','status.renames=false','status','--porcelain=v1','-z','--untracked-files=all'])).split('\0').filter(Boolean).map(s=>s.slice(3));
    for(const path of paths) {
      const full=canonical(resolve(snapshot.root,path)), after=readSource(full);if(after===undefined)continue;
      let before=snapshot.initial.get(full);
      if(before===undefined) { try { before=await git(snapshot.root,['show',`HEAD:${path}`]); } catch { before=''; } }
      if(before!==after)result.set(full,{path:full,before,after,source:'git',ownership:tracked.has(full)?'own':'unattributed'});
    }
  }
  for(const [path,entry] of tracked) { const after=readSource(path);if(after===undefined)result.set(path,{path,before:'',after:'',source:'tool',ownership:'own',unsupported:true});else if(entry.before!==after)result.set(path,{path,before:entry.before,after,source:'tool',ownership:'own'}); }
  return [...result.values()];
}
export function formatReport(result) {
  if(!result.review&&result.status!=='unchecked')return '';
  if(result.status==='unchecked')return `审查未完成：${result.error}。不得表述为已通过。${result.recovery?'\n冲突恢复依据：'+JSON.stringify(result.recovery):''}`;
  const r=result.review;
  const out=[];
  if(result.status==='partial')out.push(`未检查范围：${result.uncheckedReason}`);
  for(const f of r.findings)out.push(`[${f.ruleId}] ${f.location}\n问题：${f.problem}\n依据：${f.evidenceRefs.map(id=>`${id}（${result.payload?.evidence.find(e=>e.id===id)?.path??'来源见请求'}）`).join('、')}\n修正：${f.suggestion}`);
  if(r.neededEvidence.length)out.push(`待补证：${r.neededEvidence.join('；')}`);
  if(r.patches.length)out.push(`候选补丁（基于 ${result.candidateVersion}，需合并到待提交修改，提交前回读核对当前文件）：\n${JSON.stringify(r.patches)}`);
  return out.join('\n');
}
export function formatAuditOutput(results){
  const pending=results.filter(r=>r.status!=='checked'||r.review?.verdict!=='allow');
  const decision=results.audit?.decision??deliveryDecision(results);
  const output={status:pending.length?'needs_action':results.length?'clear':'no_recorded_changes',decision:{canFinish:decision.canFinish,nextAction:decision.nextAction},fileCount:results.audit?.fileCount??new Set(results.map(r=>r.path).filter(Boolean)).size};
  if(results.audit?.excludedFiles?.length)output.excludedFileCount=results.audit.excludedFiles.length;
  if(pending.length){
    output.results=pending.map(r=>{
      const item={path:r.path},messages=[];
      if(r.status==='unchecked')messages.push(r.error??'审查未完成');
      else{
        for(const f of r.review?.findings??[])messages.push(`${f.location} [${f.ruleId}] ${f.problem}；修正：${f.suggestion}`);
        for(const need of r.review?.neededEvidence??[])messages.push('待补证：'+need);
      }
      if(r.recovery){
        const positions=r.recovery.readRanges.map(range=>`${r.path}:${range.startLine}-${range.endLine}`).join('、');
        messages.push(`回读 ${positions}，核对并发修改并按需合并后复核`);
      }
      if(!r.review)for(const pending of r.pendingItems??[]){
        if(pending.kind==='finding')messages.push(`${pending.finding.location} ${pending.finding.problem}；修正：${pending.finding.suggestion}`);
        else messages.push('待补证：'+pending.requirement);
      }
      item.feedback=[...new Set(messages)].join('\n');return item;
    });
    output.results=output.results.filter((item,index,list)=>list.findIndex(other=>other.path===item.path&&other.feedback===item.feedback)===index);
  }
  return output;
}
function currentTask(ctx) {
  const branch=ctx.sessionManager?.getBranch?.()??[];
  const assignment=ctx.sessionManager?.getHeader?.()?.collaborationTask?.description??'';
  const messages=branch.filter(e=>e.type==='message'&&e.message?.role==='user').slice(-3);
  return (assignment+'\n'+messages.map(e=>typeof e.message.content==='string'?e.message.content:e.message.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n')).filter(Boolean).join('\n')).slice(-6000);
}
export function createReviewController(pi,{rulesPath=RULES_PATH,ask=requestReview}={}) {
  let task='', candidateSequence=0, configRaw='', evidenceSequence=0;
  const evidence=new Map(),tracked=new Map(),cache=new Map(),latest=new Map(),requests=[],files=new Map(),inFlight=new Map(),reads=new Map(),reviewed=new Map(),fileHistory=new Map(),confirmations=new Map(),auditFlights=new Map();
  let lastAudit;
  const start=async ctx=>{if(!task)task=currentTask(ctx);};
  function fileState(path) {
    const key=canonical(path);
    let state=files.get(key);
    if(!state){state={path:key,aliases:new Set(),editCalls:0,writes:0,changes:0,noOpCalls:0,failedCalls:0,active:0,version:0,status:'pending',calls:[]};files.set(key,state);}
    state.aliases.add(resolve(path));return state;
  }
  function addEvidence(path,text,source={}) {
    if(!text)return;
    const ranged=Number.isInteger(source.startLine)&&Number.isInteger(source.endLine);
    let startLine=source.startLine,endLine=source.endLine;
    let retainedId=evidence.get(ranged?JSON.stringify([path,startLine,endLine]):path)?.id;
    const numbered=value=>new Map([...value.matchAll(/^(\d+)\| ?(.*)$/gm)].map(match=>[Number(match[1]),match[2]]));
    const content=ranged?numbered(text):new Map();
    for(const [priorKey,entry] of evidence){
      if(entry.path!==path)continue;
      if(source.revision&&entry.revision!==source.revision){evidence.delete(priorKey);continue;}
      if(ranged&&entry.startLine<=endLine+1&&entry.endLine+1>=startLine&&entry.revision===source.revision){
        const prior=numbered(entry.text);
        if(content.size&&prior.size){
          for(const [line,value] of prior)if(!content.has(line))content.set(line,value);
          startLine=Math.min(startLine,entry.startLine);endLine=Math.max(endLine,entry.endLine);retainedId??=entry.id;evidence.delete(priorKey);
        }else if(entry.startLine>=startLine&&entry.endLine<=endLine)evidence.delete(priorKey);
      }
    }
    if(content.size)text=[...content].sort((a,b)=>a[0]-b[0]).map(([line,value])=>`${line}| ${value}`).join('\n');
    const key=ranged?JSON.stringify([path,startLine,endLine]):path;
    const old=evidence.get(key);if(old?.text===text&&old?.revision===source.revision)return;
    evidence.delete(key);
    evidence.set(key,{id:retainedId??`E${++evidenceSequence}`,path,text,revision:source.revision,startLine,endLine});
  }
  function readCovers(path,text,ranges){
    const proof=reads.get(path);if(proof?.revision!==createHash('sha256').update(text).digest('hex'))return false;
    return ranges.every(range=>{
      let cursor=range.startLine,end=Math.max(range.startLine,range.endLine);
      for(const read of [...proof.ranges].sort((a,b)=>a.startLine-b.startLine)){if(read.startLine>cursor)break;if(read.endLine>=cursor)cursor=read.endLine+1;if(cursor>end)return true;}
      return false;
    });
  }
  function recoveryInfo(text,conflicts){return {ranges:conflicts,readRanges:conflicts.map(r=>({startLine:Math.max(1,r.startLine-3),endLine:Math.max(1,Math.min(text.split('\n').length,Math.max(r.startLine,r.endLine)+3))})),instruction:'这些行段与并发修改重叠。回读最新源码并核对任务，必要时使用最新snapshot合并，再调用slop_check({})。工具自动核对读取版本；不需要填写路径、revision或resolutions。'};}
  function excludedTemporaryFile(path,cwd){
    return isExternalTemporaryFile(path,cwd)&&![...(files.get(canonical(path))?.aliases??[])].some(alias=>!isExternalTemporaryFile(alias,cwd));
  }
  function excludeTemporaryFile(path){
    const key=canonical(path),state=files.get(key);
    tracked.delete(key);latest.delete(key);fileHistory.delete(key);
    if(state){state.status='excluded';state.conflicts=[];state.ranges=[];}
    for(const records of [cache,reviewed,confirmations])for(const slot of records.keys())if(JSON.parse(slot)[0]===key)records.delete(slot);
    return {path:key,reason:'external-temporary-file'};
  }
  async function review(change,ctx,{phase='write',extraEvidence=[],taskOverride,force=false,configOverride,previousOverride,contextOverride,round={attempts:new Map()}}={}) {
    const reviewStarted=performance.now();let responseMetrics,flight,key,slot,sequence,confirmationKey,confirming=false,attempted=false,selected=[],materials=[];
    try {
      await start(ctx);
      if(excludedTemporaryFile(change.path,ctx.cwd))return {status:'excluded',blocked:false,skip:'external-temporary-file'};
      const loaded=configOverride?{config:validateConfig(configOverride),raw:JSON.stringify(configOverride)}:loadConfig(rulesPath);
      if(configRaw!==loaded.raw){configRaw=loaded.raw;cache.clear();}
      const rules=loaded.config.rules.filter(r=>r.enabled&&(r.checkAt.includes(phase)||phase==='settle'&&r.checkAt.includes('write')));
      if(!rules.length||change.before===change.after&&!contextOverride?.items.length)return {status:'checked',blocked:false,review:{verdict:'allow',findings:[],neededEvidence:[],patches:[]},skip:'no-change-or-rules'};
      const scoped=candidateInput(change,'cache-scope');slot=JSON.stringify([change.path,change.partKey??change.partIndex??0]);
      if(!scoped.coverageComplete){
        const scopeDiagnostics={contextChars:scoped.candidate_context.length,beforeChars:scoped.change.before.length,afterChars:scoped.change.after.length,contextLimitChars:CONTEXT_LIMIT};
        const overBudget=Math.max(scopeDiagnostics.contextChars,scopeDiagnostics.beforeChars,scopeDiagnostics.afterChars)>CONTEXT_LIMIT;
        return {status:'unchecked',blocked:false,apiAttempted:false,stage:'prepare_candidate',failureReason:overBudget?'context_limit':'diff_limit',scopeDiagnostics,error:overBudget?`该修改行段超出单次 ${CONTEXT_LIMIT} 字符上下文预算，未截断内容，也未调用模型`:'无法精确定位本轮行段，未扩大审批范围，也未调用模型'};
      }
      const policy=JSON.stringify([taskOverride??task,rules,loaded.config.reviewer.provider,loaded.config.reviewer.model,loaded.config.reviewer.thinkingLevel]);
      key=JSON.stringify([taskOverride??task,scoped.change,scoped.candidate_context,rules,loaded.config.reviewer]);
      materials=extraEvidence.length?extraEvidence:[...evidence.values()].filter(e=>canonical(e.path)!==canonical(change.path));
      const materialKey=materialVersion(materials),cached=cache.get(slot);
      const dependenciesCurrent=cached?.dependencies.every(e=>evidenceCurrent(e,materials));
      const coveredItems=(contextOverride?.items??[]).every(item=>[...(cached?.result.pendingItems??[]),...(cached?.result.confirmationChecks??[])].some(prior=>prior.id===item.id));
      const contextCurrent=!contextOverride?.items.length||cached?.confirmationKey===JSON.stringify([contextOverride.items,contextOverride.confirmation_context]);
      if(!force&&coveredItems&&contextCurrent&&cached?.key===key&&(cached.result.status==='unchecked'||dependenciesCurrent&&
        (cached.result.review?.verdict!=='needs_evidence'||cached.materialKey===materialKey)))return {...cached.result,cacheReused:true};
      if(inFlight.has(key))return {...await inFlight.get(key).promise,inFlightReused:true};
      const remembered=previousOverride===undefined?reviewed.get(slot):previousOverride,previous=remembered?.policy===policy?remembered:undefined;
      const evidenceSelection=selectEvidence(materials,previous,{query:(taskOverride??task)+'\n'+scoped.change.after});selected=evidenceSelection.selected;
      let reviewContext;
      const budgetKey=JSON.stringify([change.path,policy]);
      if(previous){
        reviewContext=contextOverride??confirmationContext(previous,change,scoped.change.ranges);
        confirming=reviewContext.items.length>0;
        if(confirming){
          let attempt=round.attempts.get(budgetKey);
          if(attempt===undefined){
            attempt=(confirmations.get(budgetKey)??0)+1;
             if(attempt>MAX_FIX_CONFIRMATIONS)return {status:'unchecked',blocked:false,apiAttempted:false,stage:'confirm_findings',failureReason:'confirmation_limit',stopRequested:true,pendingItems:reviewContext.items,error:'本轮已完成两次修正确认仍未收敛；停止自动修改并报告未确认问题，不能判通过'};
            round.attempts.set(budgetKey,attempt);confirmations.set(budgetKey,attempt);
          }
          reviewContext.confirmationAttempt=attempt;
        }else if(!dependenciesCurrent&&cached)reviewContext.mode='evidence';
        reviewContext.maxConfirmations=MAX_FIX_CONFIRMATIONS;
      }
      if(reviewContext?.items.length)confirmationKey=JSON.stringify([reviewContext.items,reviewContext.confirmation_context]);
      sequence=++candidateSequence;
      const version=`candidate-${sequence}`,input={...scoped,candidate:{...scoped.candidate,version}};
      flight=Promise.withResolvers();inFlight.set(key,flight);
      const payload={task:taskOverride??task,change:input.change,candidate_context:input.candidate_context,evidence:[...evidencePayload(selected),{id:'TASK',path:'当前用户任务',text:'原始任务与用户约束见task字段，不是后台接口来源'},{id:'CANDIDATE',path:change.path,text:'实际候选内容见change与candidate_context；confirmation_context仅用于确认原问题，不扩大新增问题或补丁范围。'}],staleEvidence:evidenceSelection.stale,omittedEvidence:evidenceSelection.omitted,candidate:input.candidate,coverageComplete:input.coverageComplete,rules,...(reviewContext?{reviewContext}:{})};
      if(requestEnvelopeChars(payload,loaded.config.reviewer)>REQUEST_LIMIT){
        const base={...payload,evidence:payload.evidence.slice(-2),omittedEvidence:[]};
        const budget=Math.max(0,REQUEST_LIMIT-requestEnvelopeChars(base,loaded.config.reviewer)-4096);
        const reduced=selectEvidence(materials,previous,{budget,query:(taskOverride??task)+'\n'+scoped.change.after});selected=reduced.selected;
        payload.evidence=[...evidencePayload(selected),...base.evidence];payload.omittedEvidence=reduced.omitted;payload.staleEvidence=reduced.stale;
      }
      if(requestEnvelopeChars(payload,loaded.config.reviewer)>REQUEST_LIMIT)throw new Error('规则、任务或单项确认要求超出请求预算，需缩小明确的取材范围；本次未发送请求');
      attempted=true;const response=await ask(payload,loaded.config.reviewer,ctx);responseMetrics=response.metrics;
      const confirmation=confirming?validateConfirmation(response.review,payload):undefined;
      const checked=validateReview(confirmation?.review??response.review,payload);
      if(reviewContext?.mode==='incremental'&&checked.findings.some(f=>!findingWithinRanges(f.location,reviewContext.corrections)))throw new Error('新增问题不在新增修改中，不能重开已通过的未改区域');
      const dependencies=evidenceDependencies(selected,checked);
      if(dependencies.some(e=>!evidenceCurrent(e,extraEvidence.length?extraEvidence:[...evidence.values()])))throw new Error('审查期间引用证据变化，结论未确认；回读对应证据，不得表述为通过');
      const pendingItems=remainingItems(checked,confirmation,reviewContext?.items??[],version,payload.change);
      const result={status:'checked',review:checked,candidateVersion:version,payload,pendingItems,reviewMode:reviewContext?.mode??'initial',confirmationChecks:confirmation?.checks??[],confirmationAttempt:reviewContext?.confirmationAttempt??0,stopRequested:confirming&&reviewContext.confirmationAttempt>=MAX_FIX_CONFIRMATIONS&&checked.verdict!=='allow',blocked:checked.verdict==='reject'&&checked.findings.some(f=>rules.find(r=>r.id===f.ruleId)?.action==='block'),...response.metrics};
      responseMetrics?.recordValidation?.('completed',{verdict:checked.verdict,stopRequested:result.stopRequested});
      requests.push({path:change.path,phase,attempted,...response.metrics,status:result.status,verdict:checked.verdict,reviewMode:result.reviewMode,confirmationAttempt:result.confirmationAttempt,confirmationChecks:result.confirmationChecks});
      if((cache.get(slot)?.sequence??0)<sequence){
        if(pendingItems.some(item=>item.kind==='finding')){
          const context=confirmationContext({after:change.after,result,pendingItems},change,scoped.change.ranges);
          confirmationKey=JSON.stringify([context.items,context.confirmation_context]);
        }else if(pendingItems.length)confirmationKey=JSON.stringify([pendingItems,'']);
        cache.set(slot,{key,result,sequence,dependencies,materialKey,confirmationKey});
        reviewed.set(slot,{policy,after:change.after,result,pendingItems,selected,sequence});
      }
      latest.set(change.path,{change,result,phase});flight.resolve(result);return result;
    } catch(error) {
      const metrics=error.metrics??responseMetrics??{};
      responseMetrics?.recordValidation?.('validation_error',{error:error.message});
      const result={status:'unchecked',blocked:false,stopRequested:confirming,error:error.message,...metrics,failureReason:metrics.failureReason??(responseMetrics?'invalid_response':'review_error'),totalMs:metrics.totalMs??Math.round(performance.now()-reviewStarted)};
      if(slot&&key&&(cache.get(slot)?.sequence??0)<(sequence??Infinity))cache.set(slot,{key,result,sequence:sequence??++candidateSequence,dependencies:[],materialKey:materialVersion(materials),confirmationKey});
      requests.push({path:change.path,phase,attempted,status:'unchecked',error:error.message,totalMs:result.totalMs,...metrics});latest.set(change.path,{change,result,phase});flight?.resolve(result);return result;
    } finally {if(flight&&inFlight.get(key)===flight)inFlight.delete(key);}
  }
  async function waitForEdits(paths,signal) {
    while(true){
      if(signal?.aborted)throw new Error('Operation aborted');
      const busy=[...files.values()].filter(f=>f.active&&(!paths||paths.includes(f.path)));
      if(!busy.length)return;
      await new Promise((resolve,reject)=>{
        const abort=()=>{cleanup();reject(new Error('Operation aborted'));};
        const cleanup=()=>signal?.removeEventListener('abort',abort);
        signal?.addEventListener('abort',abort,{once:true});
        Promise.all(busy.map(f=>f.idle.promise)).then(()=>{cleanup();resolve();},error=>{cleanup();reject(error);});
        if(signal?.aborted)abort();
      });
    }
  }
  return {
    start,addEvidence,review,
    beginEdit(path,{callId,tool,origin}={}){
      const state=fileState(path);if(!state.active)state.idle=Promise.withResolvers();
      state.active++;state.editCalls++;
      const call={callId,tool,origin,outcome:'running'};state.calls.push(call);if(state.calls.length>12)state.calls.shift();
      return {state,call,finished:false,written:false};
    },
    endEdit(token,{failed=false,alreadyApplied=false}={}){
      if(token.finished)return;token.finished=true;const state=token.state;
      if(failed){state.failedCalls++;token.call.outcome=token.written?'failed_after_write':'failed';}
      else if(!token.written){state.noOpCalls++;token.call.outcome=alreadyApplied?'already_applied':'unchanged';}
      else token.call.outcome='written';
      state.active--;if(!state.active)state.idle.resolve();
    },
    async beforeWrite(path,before,after,ctx){
      await start(ctx);
      if(excludedTemporaryFile(path,ctx.cwd))return {status:'excluded',blocked:false,skip:'external-temporary-file'};
      if(canonical(path)===canonical(rulesPath)){validateConfig(JSON.parse(after));return {status:'checked',blocked:false,maintenance:true};}
      if(!isText(before)||!isText(after))return {status:'unchecked',blocked:false,apiAttempted:false,stage:'read_source',failureReason:'non_text_content',error:'包含非文本内容，不能执行源码文本审查'};
      return {status:'pending',blocked:false};
    },
    written(path,before,after,result,token){
      const state=fileState(path),key=state.path;
      if(result?.status==='excluded'){
        excludeTemporaryFile(key);state.writes++;
        if(before!==after){state.changes++;state.version++;}
        if(token){token.written=true;token.call.ranges=[];}
        return;
      }
      let own=tracked.get(key);
      const changed=diffHunks(before,after,0);
      if(!own){own={before,after:before,conflicts:[],limited:false};tracked.set(key,own);}
      else if(own.after!==before||own.conflicts.length){
        const rebased=rebaseOwned(own.before,own.after,before,own.conflicts);
        const rewriting=rebased.conflicts.length&&readCovers(key,before,rebased.conflicts)&&rebased.conflicts.every(c=>changed.hunks.some(h=>h.beforeStartLine<=Math.max(c.startLine,c.endLine)&&h.beforeEndLine>=c.startLine));
        if(rewriting){own.before=rebased.recovery.preservedBefore;own.conflicts=[];own.limited=false;(state.resolutions??=[]).push({decision:'rewrite_latest',revision:createHash('sha256').update(before).digest('hex'),ranges:rebased.conflicts});}
        else {own.before=rebased.before;own.conflicts=rebased.conflicts;own.limited||=rebased.limited;}
      }
      own.after=after;own.beforeNonText||=!!result?.beforeNonText;
      const scope=diffHunks(own.before,after,0);
      state.ranges=scope.hunks.map(h=>({startLine:h.changedStartLine,endLine:h.changedEndLine}));state.conflicts=own.conflicts;
      state.writes++;if(before!==after){state.changes++;state.version++;state.status='pending';}
      if(token){token.written=true;token.call.ranges=changed.hunks.map(h=>({startLine:h.changedStartLine,endLine:h.changedEndLine}));}
      latest.set(key,{change:{path:key,before:own.before,after},result,phase:'write'});
    },
    captureRead(params,result,ctx){
      const source=result.details?.source;const text=result.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n');
      if(source){
        const path=canonical(source.absolutePath),proof=reads.get(path);
        if(proof?.revision===source.revision)proof.ranges.push({startLine:source.startLine,endLine:source.endLine});
        else reads.set(path,{revision:source.revision,ranges:[{startLine:source.startLine,endLine:source.endLine}]});
        addEvidence(source.absolutePath,text,source);
      }
    },
    async finalAudit(ctx,paths){
      await start(ctx);paths=paths&&[...new Set(paths.map(canonical))];
      const excludedFiles=new Map(),eligible=path=>{
        if(!excludedTemporaryFile(path,ctx.cwd))return true;
        const excluded=excludeTemporaryFile(path);excludedFiles.set(excluded.path,excluded);return false;
      };
      const pendingPaths=(paths??[...new Set([...tracked.keys(),...files.keys()])]).filter(eligible);
      await waitForEdits(pendingPaths,ctx.signal);
      const selected=paths?pendingPaths:[...tracked.keys()].filter(eligible),auditKey=JSON.stringify(selected);
      if(auditFlights.has(auditKey)){
        const existing=await auditFlights.get(auditKey),reused=existing.map(r=>({...r,inFlightReused:true}));
        Object.defineProperty(reused,'audit',{value:existing.audit});return reused;
      }
      const run=async()=>{
        const started=performance.now(),auditId=randomUUID(),requestStart=requests.length,round={attempts:new Map()};
        const groups=new Array(selected.length);let cursor=0;
        writeAuditLog(ctx,'audit_start',{auditId,fileCount:selected.length,concurrency:2,summary:'开始复核｜'+selected.length+'个文件｜最多2个文件并行'});
        const auditFile=async path=>{
          if(ctx.signal?.aborted)throw new Error('Operation aborted');
          const own=tracked.get(path);
          if(!own)return [{path,status:'unchecked',outsideScope:true,apiAttempted:false,stage:'select_scope',failureReason:'outside_turn_scope',error:'该文件不在当前会话本轮成功写入记录中，未扩大审批范围'}];
          await waitForEdits([path],ctx.signal);
          const file=files.get(path);let after;
          try{after=readSource(path);}catch(error){
            const result={status:'unchecked',apiAttempted:false,stage:'read_source',failureReason:'source_read_error',ranges:file?.ranges??[],error:error.message};
            if(file)file.status='unchecked';latest.set(path,{change:{path,before:own.before,after:own.after},result,phase:'settle'});return [{path,...result}];
          }
          if(after===undefined||!isText(own.before)||own.beforeNonText){
            const result={status:'unchecked',apiAttempted:false,stage:'read_source',failureReason:'non_text_content',ranges:file?.ranges??[],error:'文件包含二进制内容或无法按 UTF-8 文本解码，未执行源码文本审查'};
            if(file)file.status='unchecked';latest.set(path,{change:{path,before:own.before,after:own.after},result,phase:'settle'});return [{path,...result}];
          }
          let scoped=rebaseOwned(own.before,own.after,after,own.conflicts),conflicts=scoped.conflicts;
          if(conflicts.length&&scoped.recovery?.adoptable&&readCovers(path,after,conflicts)){
            own.before=scoped.recovery.resolvedBefore;own.after=after;own.conflicts=[];own.limited=false;
            if(file){file.version++;file.conflicts=[];(file.resolutions??=[]).push({decision:'read_latest',ranges:conflicts});}
            scoped={before:own.before,after,conflicts:[],limited:false};conflicts=[];
          }
          if(conflicts.length||own.limited||scoped.limited){
            const result={status:'unchecked',stale:true,apiAttempted:false,stage:'prepare_candidate',failureReason:conflicts.length?'overlapping_changes':'diff_limit',ranges:conflicts.length?conflicts:file?.ranges??[],scopeDiagnostics:{sourceBytes:Buffer.byteLength(after)},conflicts,recovery:conflicts.length?recoveryInfo(after,conflicts):undefined,error:conflicts.length?'重叠修改待恢复：回读最新行段，补齐本任务或确认最新结果已满足要求，再重新审查':'无法精确定位本轮行段，未扩大审批范围'};
            if(file){file.status='pending';file.conflicts=conflicts;}latest.set(path,{change:{path,before:own.before,after},result,phase:'settle'});return [{path,...result}];
          }
          const loaded=loadConfig(rulesPath),rules=loaded.config.rules.filter(r=>r.enabled&&(r.checkAt.includes('settle')||r.checkAt.includes('write')));
          const policy=JSON.stringify([task,rules,loaded.config.reviewer.provider,loaded.config.reviewer.model,loaded.config.reviewer.thinkingLevel]);
          const remembered=fileHistory.get(path),previous=remembered?.policy===policy?remembered:undefined;
          if(after===scoped.before&&!previous?.pendingItems.length){
            const result={status:'checked',review:{verdict:'allow',findings:[],neededEvidence:[],patches:[]},skip:'no-change'};
            if(file)file.status='unchanged';latest.set(path,{change:{path,before:scoped.before,after},result,phase:'settle'});return [{path,...result}];
          }
          if(canonical(path)===canonical(rulesPath)){validateConfig(JSON.parse(after));return [{path,status:'checked',review:{verdict:'allow',findings:[],neededEvidence:[],patches:[]},maintenance:true}];}
          const change={path,before:scoped.before,after},version=file?.version;
          const fixed=requestEnvelopeChars({task,rules,change:{path},candidate_context:'',evidence:[]},loaded.config.reviewer);
          const limit=Math.max(128,Math.min(CONTEXT_LIMIT,Math.floor((REQUEST_LIMIT-fixed-22000)/4)));
          const withinBudget=input=>requestEnvelopeChars({task,rules,...input,evidence:[]},loaded.config.reviewer)+22000<=REQUEST_LIMIT;
          const parts=partitionChange(change,limit,withinBudget),partResults=[],plan=reviewPlan(previous,change,parts);
          if(file){file.status='reviewing';file.ranges=diffHunks(change.before,after,0).hunks.map(h=>({startLine:h.changedStartLine,endLine:h.changedEndLine}));}
          for(const entry of plan){
            const input=candidateInput(entry.part,'identity'),partKey=createHash('sha256').update(JSON.stringify([input.change,entry.batchKey??0])).digest('hex');
            const part={...entry.part,partKey};let result=await review(part,ctx,{phase:'settle',round,previousOverride:previous??null,contextOverride:entry.context});
            if(file?.active||file&&file.version!==version||readSource(path)!==after)result={status:'unchecked',blocked:false,failureReason:'candidate_changed',stage:'validate_candidate',error:'审查期间文件再次编辑，旧版本结论已失效，需复核最新行段',stale:true};
            partResults.push({path,ranges:result.payload?.change.ranges??input.change.ranges,...result,scopeDiagnostics:{sourceBytes:Buffer.byteLength(after),...result.scopeDiagnostics}});
            if(result.stale)break;
          }
          if(!partResults.some(r=>r.stale)){
            const checked=partResults.filter(r=>r.status==='checked'),resolved=new Set(checked.flatMap(r=>(r.confirmationChecks??[]).filter(c=>c.state==='resolved').map(c=>c.id)));
            const mapped=previous?confirmationContext(previous,change,parts.flatMap(p=>candidateInput(p,'history').change.ranges)).items:[];
            const pending=new Map(mapped.filter(item=>!resolved.has(item.id)).map(item=>[item.id,item]));
            for(const result of checked)for(const item of result.pendingItems??[])pending.set(item.id,item);
            const items=[...pending.values()],findings=items.filter(i=>i.kind==='finding').map(i=>i.finding),neededEvidence=items.filter(i=>i.kind==='evidence').map(i=>i.requirement);
            const selected=[...new Map([...reviewed].filter(([slot])=>JSON.parse(slot)[0]===path).flatMap(([,record])=>record.selected).map(entry=>[entry.id,entry])).values()];
            fileHistory.set(path,{policy,after,pendingItems:items,selected,result:{candidateVersion:checked.at(-1)?.candidateVersion??previous?.result.candidateVersion,review:{verdict:neededEvidence.length?'needs_evidence':findings.length?'reject':'allow',findings,neededEvidence,patches:[]},payload:{change:{ranges:file?.ranges??[]}}}});
            const reported=new Set(partResults.flatMap(r=>(r.pendingItems??[]).map(i=>i.id)));
            const unconfirmed=items.filter(item=>!reported.has(item.id)&&!resolved.has(item.id));
            if(unconfirmed.length)partResults.push({path,status:'unchecked',stopRequested:partResults.some(r=>r.stopRequested),failureReason:'confirmation_incomplete',pendingItems:unconfirmed,error:'原问题仍待逐项确认'});
          }
          const aggregate=partResults.find(r=>r.status!=='checked'||r.review?.verdict!=='allow')??partResults[0];
          latest.set(path,{change,result:aggregate,phase:'settle'});
          if(file){file.status=aggregate.stale?'pending':aggregate.status==='checked'?aggregate.review.verdict:'unchecked';file.reviewedVersion=version;}
          return partResults;
        };
        const worker=async()=>{
          while(cursor<selected.length){
            const index=cursor++;
            try{groups[index]=await auditFile(selected[index]);}
            catch(error){if(ctx.signal?.aborted)throw error;groups[index]=[{path:selected[index],status:'unchecked',failureReason:'audit_error',error:error.message}];}
          }
        };
        const workers=Array.from({length:Math.min(2,selected.length)},()=>worker());
        const settled=await Promise.allSettled(workers);
        const results=groups.flat();
        if(!selected.length&&paths&&!excludedFiles.size)results.push({path:ctx.cwd,status:'unchecked',apiAttempted:false,stage:'select_scope',failureReason:'empty_scope',error:'审计路径范围为空，未执行检查'});
        const error=settled.find(r=>r.status==='rejected');
        const decision=error?{state:'cancelled',canFinish:false,shouldStop:true,nextAction:'report_unchecked',reason:'用户已取消，检查未完成'}:deliveryDecision(results);
        if(!results.length&&excludedFiles.size&&!error)decision.reason='本轮仅有工作目录外的临时文件，已排除，不声明审查通过';
        const unchecked=results.filter(r=>r.status==='unchecked').map(({path,ranges,failureReason,error,stage,scopeDiagnostics})=>({path,ranges,failureReason,error,stage,scopeDiagnostics}));
        lastAudit={auditId,fileCount:selected.length,excludedFiles:[...excludedFiles.values()],partCount:results.filter(r=>r.ranges?.length).length,cacheHits:results.filter(r=>r.cacheReused).length,inFlightReused:results.filter(r=>r.inFlightReused).length,modelRequests:requests.slice(requestStart).filter(r=>r.apiAttempted??r.attempted).length,totalMs:Math.round(performance.now()-started),unchecked,decision};
        Object.assign(lastAudit,writeAuditLog(ctx,'audit_completed',{...lastAudit,summary:'复核结束｜'+lastAudit.fileCount+'个文件｜排除临时文件'+lastAudit.excludedFiles.length+'｜'+lastAudit.modelRequests+'次请求｜缓存命中'+lastAudit.cacheHits+'｜未检查'+unchecked.length+'段｜'+(lastAudit.totalMs/1000).toFixed(1)+'秒｜'+decision.nextAction}));
        if(error)throw error.reason;
        Object.defineProperty(results,'audit',{value:lastAudit});return results;
      };
      const promise=run();auditFlights.set(auditKey,promise);
      try{return await promise;}finally{if(auditFlights.get(auditKey)===promise)auditFlights.delete(auditKey);}
    },
    status(){return {lastAudit,rulesPath,task,requests:[...requests],trackedFiles:[...tracked.keys()],files:[...files.values()].map(f=>({path:f.path,aliases:[...f.aliases],editCalls:f.editCalls,writes:f.writes,changes:f.changes,noOpCalls:f.noOpCalls,failedCalls:f.failedCalls,active:f.active,version:f.version,repeatedCalls:f.editCalls>1,multipleEdits:f.changes>1,ranges:f.ranges??[],conflicts:f.conflicts??[],resolutions:f.resolutions??[],status:f.status,reviewedVersion:f.reviewedVersion,calls:f.calls.map(c=>({...c}))})),latest:[...latest].map(([path,{result}])=>({path,status:result.status,verdict:result.review?.verdict,blocked:result.blocked,error:result.error,failureReason:result.failureReason,scopeDiagnostics:result.scopeDiagnostics,omittedEvidence:result.payload?.omittedEvidence}))};},
    updateTask(text,{append=false}={}){if(text&&text!==task){task=append&&task?task+'\n用户补充：'+text:text;cache.clear();}},
  };
}
export { REVIEW_SCHEMA };
