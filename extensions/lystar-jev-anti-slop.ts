import {createReadToolDefinition,createEditToolDefinition,createWriteToolDefinition,type ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {Type} from 'typebox';
import {access,readFile,writeFile,mkdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve} from 'node:path';
import {createReviewController,formatAuditOutput,decodeSource,RULES_PATH} from './lystar-jev-anti-slop/anti-slop.mjs';

export function registerAntiSlop(pi:ExtensionAPI,options:any={}) {
 const controllers=new WeakMap<object,Map<string,any>>();
 const last=new WeakMap<object,any>();
 const instances=new Set<any>();
 function controller(ctx:any){
  const key=ctx.sessionManager??ctx;let group=controllers.get(key);if(!group){group=new Map();controllers.set(key,group);}
  const turn=ctx.currentTurn;
  const origin=turn?.origin;
   const inputId=typeof turn?.inputId==='string'&&turn.inputId.trim()?turn.inputId:undefined;
   if(!inputId){
    const isolated=createReviewController(pi,options),error='缺少当前输入轮次标识，无法确认本轮修改范围；未复用其他轮次状态';
    return {...isolated,beforeWrite:async()=>({status:'unchecked',scopeUnavailable:true,failureReason:'missing_input_id',error}),finalAudit:async()=>[{status:'unchecked',scopeUnavailable:true,failureReason:'missing_input_id',error}]};
   }
   const id=origin?.type==='room'?'room:'+origin.roomId+':'+(origin.taskId??origin.messageId)+':'+inputId:turn.rootOrigin==='room'?'room-turn:'+inputId:'user:'+inputId;
   let found=group.get(id);
  if(!found){found=createReviewController(pi,options);group.set(id,found);instances.add(found);}
  last.set(key,found);
  while(group.size>8){const oldest=group.keys().next().value!;instances.delete(group.get(oldest));group.delete(oldest);}
  return found;
 }
 const factory={read:createReadToolDefinition,edit:createEditToolDefinition,write:createWriteToolDefinition};
 for(const name of ['read','edit','write'] as const){
  const base=factory[name](process.cwd());
  pi.registerTool({...base,execute:async(id:string,params:any,signal:AbortSignal|undefined,onUpdate:any,ctx:any)=>{
   const active=controller(ctx);await active.start(ctx);
   if(name==='read'){
    const result=await createReadToolDefinition(ctx.cwd).execute(id,params as any,signal,onUpdate,ctx);
    active.captureRead(params,result,ctx);return result;
   }
   if(typeof active.beginEdit!=='function'||typeof active.endEdit!=='function'){
     const result=await (factory[name] as any)(ctx.cwd).execute(id,params,signal,onUpdate,ctx);
     result.details={...result.details,antiSlop:{status:'unchecked',error:'审查控制器接口未同步；本次使用原生文件工具，未完成内部审查'}};
     return result;
    }
    const path=resolve(ctx.cwd,params.path as string);
   const token=active.beginEdit(path,{callId:id,tool:name,origin:ctx.currentTurn?.origin?.type});
   const frame:any={before:'',after:'',notWritten:false,attempted:false};let failed=false,alreadyApplied=false;
   const operations:any={
    access:(p:string)=>access(p,constants.R_OK|constants.W_OK),
     readFile:async(p:string)=>{const bytes=await readFile(p);frame.before=bytes.toString('utf8');frame.beforeNonText=decodeSource(bytes)===undefined;return bytes;},
    mkdir:(p:string)=>mkdir(p,{recursive:true}),
    writeFile:async(p:string,content:string)=>{
     frame.notWritten=true;frame.after=content;
     frame.report=await active.beforeWrite(path,frame.before,content,ctx);
     if(frame.beforeNonText)frame.report={status:'unchecked',beforeNonText:true,failureReason:'non_text_content',error:'原文件无法作为 UTF-8 文本读取，不能核对修改前内容'};
     if(signal?.aborted||ctx.signal?.aborted)throw new Error('Operation aborted');
     let current='';try{current=await readFile(p,'utf8');}catch(error:any){if(error.code!=='ENOENT')throw error;}
     if(current!==frame.before)throw new Error('写入前文件版本变化，请重新读取后提交');
     frame.attempted=true;await writeFile(p,content);frame.notWritten=false;
     active.written(path,frame.before,content,frame.report,token);
    }
   };
   try{
    const native=(factory[name] as any)(ctx.cwd,{operations});
    const result=await native.execute(id,params,signal,onUpdate,ctx);
    alreadyApplied=!!result.details?.alreadyApplied&&!token.written;
     if(frame.report)result.details={...result.details,antiSlop:{status:frame.report.status,error:frame.report.error,failureReason:frame.report.failureReason,scopeDiagnostics:frame.report.scopeDiagnostics,deferred:frame.report.status==='pending',file:token.state.path,editCalls:token.state.editCalls,changes:token.state.changes,multipleEdits:token.state.changes>1}};
    return result;
   }catch(error:any){
    failed=true;
    if(frame.notWritten&&!frame.attempted){
     const failure=new Error(`文件未写入：${String(error?.message??error).split('\n')[0]}`,{cause:error});
     Object.assign(failure,{details:{...error?.details,path,status:'not_written',writeState:'not_written'},retryable:true,terminate:false});
     throw failure;
    }
    throw error;
   }finally{active.endEdit(token,{failed,alreadyApplied});}
  }} as any);
 }
  pi.registerTool({name:'slop_check',label:'交付前规则复核',description:'无需参数，检查当前会话本轮实际修改。普通文本按内容识别，大段和长行分片检查；默认仅返回判定与必要问题。详细诊断见 /slop-check status。修正后逐项确认，同文件分片共用一轮，两轮仍未收敛则停止报告。',promptSnippet:'修改完成后调用slop_check({})；decision.nextAction=finish时结束。report_remaining/report_unchecked时报告未完成项，不再自动请求。',promptGuidelines:['只检查本轮实际写入内容，不扫描整个项目。按反馈修正、补证或回读冲突位置，不扩大问题清单。finish时交付；report_remaining/report_unchecked时停止自动修改与复核，不能称为通过。'],parameters:Type.Object({}),execute:async(_id:string,_params:any,signal:AbortSignal|undefined,_update:any,ctx:any)=>{
   const active=controller(ctx),auditCtx=Object.defineProperty(Object.create(ctx),'signal',{value:signal??ctx.signal});
   const results=await active.finalAudit(auditCtx);
   const output=formatAuditOutput(results);
   return {content:[{type:'text',text:JSON.stringify(output)}],details:output};
 }} as any);
 pi.registerCommand('slop-check',{description:'检查最终差异；status查看实际请求统计',handler:async(args,ctx)=>{
   if(args.trim()==='status'){
    const latest=last.get(ctx.sessionManager??ctx);
    console.log(JSON.stringify({diagnosticOnly:true,...(latest?.status()??{status:'no_recorded_turn'})}));return;
   }
   const active=controller(ctx);
   const results=await active.finalAudit(ctx);console.log(JSON.stringify(formatAuditOutput(results)));
 }});
 pi.on('session_start',async(_event:any,ctx:any)=>{await controller(ctx).start(ctx);});
 (pi.on as any)('before_agent_start',async(_event:any,ctx:any)=>{await controller(ctx).start(ctx);},{scope:{origins:['user','extension']}} as any);
 (pi.on as any)('input',(event:any,ctx:any)=>{controller(ctx).updateTask(event.text,{append:!ctx.isIdle()});},{scope:{origins:['user']}} as any);
 (pi.on as any)('tool_result',(event:any,ctx:any)=>{
   if(event.isError||['read','edit','write','codemode','slop_check','step_start','step_end'].includes(event.toolName)||event.toolName.startsWith('session_')||event.toolName.startsWith('room_'))return;
  const text=event.content?.filter((item:any)=>item.type==='text').map((item:any)=>item.text).join('\n');
  if(text)controller(ctx).addEvidence('tool:'+event.toolName+':'+event.toolCallId,text);
 },{scope:{origins:['user','extension']}} as any);
 return {controller,instances};
}
export default function(pi:ExtensionAPI){registerAntiSlop(pi);}
