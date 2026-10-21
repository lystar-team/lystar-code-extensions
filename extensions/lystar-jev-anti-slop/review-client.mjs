import {appendFileSync,mkdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
export const REVIEW_SYSTEM = `你是独立代码审查者。只审查本次 change.ranges 指定的当前会话本轮修改行段，结合 candidate_context、task、rules 和 evidence。周边上下文只用于理解，不能审查、修复其既有问题或其他会话的修改。
所有审查规则来自本次请求的 rules，不使用隐藏规则、通用偏好或关键词黑名单。先依据scenarios（前端、后端、文档文案、通用）、scope、任务与源码判断规则是否适用；不单凭语言后缀分类，混合产物分别判断。通用规则仍受scope和exceptions约束；文档中的源码例子不是可执行业务产物。只对适用规则做判断，不索要无关场景证据。只有规则适用、证据充分且修改已经引入违规时才能reject。
缺少决定性业务事实时返回 needs_evidence，并明确所需材料；没有违规或满足例外时返回 allow。不得让未在本次修改的既有问题阻断局部修改。先判断适用性，不逐条索要与当前修改无关的材料。技术文档、源码注释、规则正反例与用户可见业务产物不同。
证据引用只能使用给定 evidence 的 id，准确反映其内容。任务优先级和明确例外必须保留；缺少目标用户时不默认普通业务人员。不要编造接口、选项、组件功能或规则。相同问题选最具体规则，不重复计数。首次审查一次列出全部有依据的确定问题，不人为拆成多轮；每条 problem 与 suggestion 各不超过70个汉字。
返回规定JSON：allow时findings、neededEvidence和patches均为空；reject时给规则、位置、具体问题、证据和修正方向；needs_evidence时neededEvidence非空且patches为空。
只返回问题位置、依据和修正方向，patches为空；不返回重复源码。location使用“文件:行号”或“文件:行号:列号”；同一问题涉及多处时可使用“文件:25,65,71”或“文件:25-27,65”。确认时必须核对该问题的全部关联位置；location只有章节名称时，使用items.scope记录的原审查行段核对，不能猜测行号或只凭修改摘要判断解决。
reviewContext.mode=verify时，逐项确认items：checks必须恰好覆盖每个id，说明resolved/unresolved/needs_evidence及证据。confirmation_context是原问题对应的最新只读源码，包含还原到基线或已删除位置；只能用于确认原问题，不扩大新增问题或补丁范围。已有问题全部resolved且修正未引入确定违规时allow。不得因首次遗漏的未改代码、措辞或偏好另开问题。已有未解决finding使用findingSources.checkId关联原id、correctionIndex=-1，problem和suggestion沿用原文，location按最新行号；新增项checkId为空，指向真实correction索引，给匹配beforeSnippet、afterSnippet和引入原因。证据变化时保留原清单，仅重新确认受影响问题；缺少更新后的决定性证据应needs_evidence，不猜测解决。
检查失败或缺覆盖不能宣称通过。change.afterFrom=candidate_context时，按change.ranges从编号源码提取修改后文本；纯删除对应空范围，不把空隙旁的上下文当成新增代码。
change.fragments存在时，候选是连续大段或长行的分片；before和after位置独立标明原行、列及字符偏移，列从1开始，末列不包含在片段内。编号形如行:列|内容。分片之外的内容没有消失，不把片段首尾误判成完整语法单元；相邻重叠材料只用于理解。需要跨片业务关系时明确返回所需位置，不能猜测。长行问题用文件:行:列定位。candidate.partialLines=true时禁止提供整行替换补丁。
reviewContext是本次分批确认的子集，checks完整覆盖本次items即可；其余问题由程序保留并另外确认。`;
const finding={type:'object',properties:{ruleId:{type:'string'},location:{type:'string'},problem:{type:'string'},evidenceRefs:{type:'array',items:{type:'string'}},suggestion:{type:'string'}},required:['ruleId','location','problem','evidenceRefs','suggestion'],additionalProperties:false};
const patch={type:'object',properties:{candidateVersion:{type:'string'},ruleId:{type:'string'},startLine:{type:'integer'},endLine:{type:'integer'},newText:{type:'string'}},required:['candidateVersion','ruleId','startLine','endLine','newText'],additionalProperties:false};
export const REVIEW_SCHEMA={type:'object',properties:{verdict:{type:'string',enum:['allow','reject','needs_evidence']},findings:{type:'array',items:finding},neededEvidence:{type:'array',items:{type:'string'}},patches:{type:'array',items:patch}},required:['verdict','findings','neededEvidence','patches'],additionalProperties:false};
const check={type:'object',properties:{id:{type:'string'},state:{type:'string',enum:['resolved','unresolved','needs_evidence']},reason:{type:'string'},evidenceRefs:{type:'array',items:{type:'string'}}},required:['id','state','reason','evidenceRefs'],additionalProperties:false};
const findingSource={type:'object',properties:{findingIndex:{type:'integer'},checkId:{type:'string'},correctionIndex:{type:'integer'},beforeSnippet:{type:'string'},afterSnippet:{type:'string'},reason:{type:'string'}},required:['findingIndex','checkId','correctionIndex','beforeSnippet','afterSnippet','reason'],additionalProperties:false};
export const CONFIRMATION_SCHEMA={...REVIEW_SCHEMA,properties:{...REVIEW_SCHEMA.properties,checks:{type:'array',items:check},findingSources:{type:'array',items:findingSource}},required:[...REVIEW_SCHEMA.required,'checks','findingSources']};

export function serializeReviewPayload(payload){
 const {after,...change}=payload.change??{};
 const compact=payload.candidate_context!==undefined&&payload.change?{...payload,change:{...change,afterFrom:'candidate_context'}}:payload;
 return JSON.stringify(compact);
}
export const REQUEST_LIMIT=128000;
function requestBody(payload,config){
 const verify=payload.reviewContext?.mode==='verify';
 return {model:config.model,instructions:REVIEW_SYSTEM,input:[{role:'user',content:[{type:'input_text',text:serializeReviewPayload(payload)}]}],reasoning:{effort:config.thinkingLevel},max_output_tokens:config.maxOutputTokens,text:{format:{type:'json_schema',name:verify?'rule_review_confirmation':'rule_review_patch',strict:true,schema:verify?CONFIRMATION_SCHEMA:REVIEW_SCHEMA}},stream:true,store:false};
}
export function requestEnvelopeChars(payload,config){return JSON.stringify(requestBody(payload,config)).length;}
export function writeAuditLog(ctx,event,fields){
 const logPath=ctx.reviewLogPath??join(homedir(),'.pi/agent/logs/slop-check',new Date().toISOString().slice(0,10)+'.jsonl');
 try{
  mkdirSync(dirname(logPath),{recursive:true});
  appendFileSync(logPath,JSON.stringify({time:new Date().toISOString(),event,sessionId:ctx.sessionManager?.getSessionId?.()??null,inputId:ctx.currentTurn?.inputId??null,...fields})+'\n');
  return {logPath,logError:null};
 }catch(error){return {logPath,logError:error.message};}
}
export async function requestReview(payload,config,ctx) {
 const started=performance.now(), deadline=AbortSignal.timeout(config.timeoutMs);
 const signal=ctx.signal?AbortSignal.any([ctx.signal,deadline]):deadline;
 let completion,firstTextMs,headersMs,firstEventMs,firstChunkMs,lastEventType,raw='',buffer='',attempted=false,resolveMs=0,requestBytes=0,httpStatus;
 const requestId=randomUUID(),payloadText=serializeReviewPayload(payload),sent=JSON.parse(payloadText),sections=Object.fromEntries(['task','change','candidate_context','evidence','rules','reviewContext'].map(key=>[key,JSON.stringify(sent[key]??'').length]));
 const logPath=ctx.reviewLogPath??join(homedir(),'.pi/agent/logs/slop-check',new Date().toISOString().slice(0,10)+'.jsonl');
 const identity={requestId,path:payload.change?.path??null,ranges:payload.change?.ranges??[],inputId:ctx.currentTurn?.inputId??null,sessionId:ctx.sessionManager?.getSessionId?.()??null,reviewMode:payload.reviewContext?.mode??'initial',confirmationItems:payload.reviewContext?.items?.length??0};
 let stage='resolve_model',logError;
 const elapsed=()=>Math.round(performance.now()-started);
 const stageNames={resolve_model:'解析模型',resolve_auth:'读取认证',await_headers:'等待远端响应头',await_event:'等待首个流事件',await_text:'等待模型正文',receiving_text:'接收模型正文',validate_response:'校验完整结果'};
 const eventNames={start:'开始',request:'已发送',headers:'收到响应头',first_chunk:'收到流数据',first_event:'收到流事件',first_text:'开始返回正文',waiting:'仍在等待',response_received:'完整响应已收到，待程序校验',completed:'程序校验完成',validation_error:'程序校验未通过',timeout:'超时',cancelled:'已取消',error:'失败'};
 function log(event,extra={}){
   try{mkdirSync(dirname(logPath),{recursive:true});appendFileSync(logPath,JSON.stringify({time:new Date().toISOString(),event,...identity,stage,summary:`${eventNames[event]}｜${identity.path??'审查请求'}｜${stageNames[stage]}｜${(elapsed()/1000).toFixed(1)}秒｜上下文${payloadText.length}字符｜请求${(requestBytes/1024).toFixed(1)}KB`,elapsedMs:elapsed(),provider:config.provider,model:config.model,effort:config.thinkingLevel,timeoutMs:config.timeoutMs,...extra})+'\n');}
  catch(error){logError=error.message;}
 }
 log('start',{payloadChars:payloadText.length,sections});
 const progress=setInterval(()=>log('waiting',{firstEventMs:firstEventMs??null,firstTextMs:firstTextMs??null,lastEventType:lastEventType??null}),15000);progress.unref?.();
 try {
 const model=await ctx.modelRegistry.getModelOfType('chat',config.provider,config.model);
 if(!model||model.api!=='openai-responses'||typeof model.baseUrl!=='string')throw new Error('当前审查客户端需要已配置的Responses模型');
 stage='resolve_auth';
 const resolved=await ctx.modelRegistry.getProviderAuth(config.provider);
 const auth=resolved?.auth;
 if(!auth?.apiKey)throw new Error('审查provider未提供可用认证');
 const headers={'Content-Type':'application/json',Accept:'text/event-stream',...model.headers,...auth.headers};
 if(!Object.keys(headers).some(k=>k.toLowerCase()==='authorization'))headers.Authorization=`Bearer ${auth.apiKey}`;
  const bodyText=JSON.stringify(requestBody(payload,config));requestBytes=Buffer.byteLength(bodyText);
  if(bodyText.length>REQUEST_LIMIT)throw new Error('完整审查请求超出本地调度预算，未发送请求');
 resolveMs=elapsed();attempted=true;stage='await_headers';log('request',{resolveMs,requestBytes});
 const response=await fetch(model.baseUrl.replace(/\/$/,'')+'/responses',{method:'POST',headers,body:bodyText,signal});
 headersMs=elapsed();httpStatus=response.status;stage='await_event';log('headers',{httpStatus,headersMs});
 if(!response.ok){await response.body?.cancel();throw new Error(`审查接口HTTP ${response.status}`);}
 const reader=response.body.getReader(), decoder=new TextDecoder();
 try {
  while(true){
   const {done,value}=await reader.read();
   if(value&&firstChunkMs===undefined){firstChunkMs=elapsed();log('first_chunk',{firstChunkMs});}
   buffer+=decoder.decode(value??new Uint8Array(),{stream:!done});
   const rows=buffer.split('\n');buffer=rows.pop();
   for(const row of rows){
    if(!row.startsWith('data:'))continue;const text=row.slice(5).trim();if(!text||text==='[DONE]')continue;
   const event=JSON.parse(text);lastEventType=event.type;
   if(firstEventMs===undefined){firstEventMs=elapsed();stage='await_text';log('first_event',{firstEventMs,eventType:event.type});}
   if(event.type==='response.output_text.delta'){
    if(firstTextMs===undefined){firstTextMs=elapsed();stage='receiving_text';log('first_text',{firstTextMs});}
    raw+=event.delta||'';
   }
    if(['response.completed','response.incomplete','response.failed'].includes(event.type))completion=event.response;
    if(event.type==='error')throw new Error('审查响应流返回错误');
   }
   if(completion||done)break;
  }
 }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  stage='validate_response';
  if(completion?.status!=='completed')throw new Error('审查响应未完整结束');
 if(completion.model!==config.model||completion.reasoning?.effort!==config.thinkingLevel)throw new Error('响应模型或思考强度与请求不一致');
 if(!raw)raw=(completion.output??[]).flatMap(o=>o.content??[]).filter(c=>c.type==='output_text').map(c=>c.text).join('');
 const review=JSON.parse(raw),metrics=reviewMetrics();log('response_received',{...metrics,verdict:review.verdict,confirmationStates:(review.checks??[]).map(check=>({id:check.id,state:check.state}))});
 Object.defineProperty(metrics,'recordValidation',{enumerable:false,value:(status,details={})=>log(status,{...metrics,...details})});
 return {review,metrics};
 }catch(error){
   const timedOut=deadline.aborted&&!ctx.signal?.aborted,cancelled=!!ctx.signal?.aborted;
    const reason=timedOut?'timeout':cancelled?'cancelled':stage==='validate_response'?'invalid_response':'error';
    const failure=new Error(timedOut?'审查请求超过'+config.timeoutMs+'毫秒，未完成':error.message,{cause:error});
   failure.metrics={...reviewMetrics(),failureReason:reason};log(reason==='invalid_response'?'validation_error':reason,{...failure.metrics,error:failure.message});throw failure;
 }finally{clearInterval(progress);}
 function reviewMetrics(){const usage=completion?.usage;return {requestId,logPath,logError:logError??null,stage,payloadChars:payloadText.length,sections,requestBytes,httpStatus:httpStatus??null,provider:config.provider,requestedModel:config.model,returnedModel:completion?.model??null,requestedEffort:config.thinkingLevel,returnedEffort:completion?.reasoning?.effort??null,apiAttempted:attempted,timeoutMs:config.timeoutMs,resolveMs,totalMs:elapsed(),headersMs:headersMs??null,firstChunkMs:firstChunkMs??null,firstEventMs:firstEventMs??null,lastEventType:lastEventType??null,outputChars:raw.length,firstTextMs:firstTextMs===undefined?null:Math.round(firstTextMs),usage:usage??null,inputTokens:usage?.input_tokens??null,cachedInputTokens:usage?.input_tokens_details?.cached_tokens??null,outputTokens:usage?.output_tokens??null,reasoningTokens:usage?.output_tokens_details?.reasoning_tokens??null};}
}
