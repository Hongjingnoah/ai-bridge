import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import * as mcp from '@deepseek-ai/dsh-mcp-client';
import {createUserMessage} from '@deepseek-ai/dsh-llm';

export const name='ai-bridge-native';
export const inject=['webServer'];
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const NODE=process.env.DSH_NODE||path.join(process.env.LOCALAPPDATA||path.join(process.env.USERPROFILE||'','AppData','Local'),'Programs','DeepSeek Harness','resources','runtime','primary-runtime','dependencies','node','bin','node.exe');
const SERVER='codex-bridge-native';
const tokenFile=path.join(ROOT,'state','dispatch.token');

function send(response,status,body){response.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});response.end(JSON.stringify(body));}
function summary(session,firstSeq){
  let started=false, answer='', reason=null;const tools=[];
  for(let seq=firstSeq;seq<session.seq;seq++){
    const event=session.eventAt(seq);if(!event)continue;
    if(event.type==='turn/start')started=true;
    if(!started)continue;
    if(event.type==='assistant/message'){
      const blocks=event.data?.message?.content||[];
      const text=blocks.filter(x=>x.type==='text').map(x=>x.text).join('');if(text)answer=text;
      for(const block of blocks)if(block.type==='tool_use'||block.type==='tool-call')tools.push(block.name||block.toolName||null);
    }
    if(event.type==='turn/end')reason=event.data?.reason||null;
  }
  return {answer,reason,tools};
}
export async function apply(ctx){
  const jobs=new Map(),queues=new Map();
  fs.mkdirSync(path.dirname(tokenFile),{recursive:true});
  let token=fs.existsSync(tokenFile)?fs.readFileSync(tokenFile,'utf8').trim():'';
  if(!token){token=randomBytes(32).toString('hex');fs.writeFileSync(tokenFile,token,{mode:0o600});}
  let mounted=false;
  ctx.inject(['tools'],async(toolCtx)=>{
    const handle=toolCtx.plugin(mcp,{serverName:SERVER,transport:'stdio',command:NODE,args:[path.join(ROOT,'bin','codex-bridge-mcp.mjs')],cwd:ROOT,toolCallTimeoutMs:650000,failOnStartupError:true});
    await handle.await();mounted=true;
  });
  const admitted=request=>{
    const host=String(request.headers.host||'').split(':')[0];
    if(!['127.0.0.1','localhost'].includes(host))return false;
    const origin=request.headers.origin;if(origin && origin!==`http://${request.headers.host}`)return false;
    const supplied=Buffer.from(String(request.headers['x-ai-bridge-token']||''));const expected=Buffer.from(token);
    return supplied.length===expected.length && timingSafeEqual(supplied,expected);
  };
  const register=(endpoint,handler)=>ctx.webServer.register({kind:'exact',path:endpoint,handler:async(request,response)=>{
    if(!admitted(request)){send(response,403,{ok:false,error:'unauthorized local dispatch'});return;}
    try{await handler(request,response);}catch(error){send(response,500,{ok:false,error:error.message});}
  }});
  const status=register('/ai-bridge/status',async(request,response)=>{
    if(request.method!=='GET'){send(response,405,{ok:false});return;}
    const runtime=ctx.get('agents');
    const agents=(runtime?.list()||[]).map(a=>{const live=runtime.get(a.id);return {id:a.id,status:a.status,keys:live?Object.keys(live):[],hasCtx:!!live?.ctx};});
    send(response,200,{ok:true,mounted,rootTools:!!ctx.get('tools'),serverName:SERVER,tools:[`mcp__codex_bridge_native__codex_ask`,`mcp__codex_bridge_native__codex_health`],agents,jobs:[...jobs.values()]});
  });
  const dispatch=register('/ai-bridge/tasks',async(request,response)=>{
    if(request.method!=='POST'){send(response,405,{ok:false});return;}
    let body='';for await(const chunk of request){body+=chunk;if(Buffer.byteLength(body)>65536){send(response,413,{ok:false});return;}}
    const value=JSON.parse(body);const task=String(value.task||'').trim();const id=String(value.sessionId||'');
    const agent=ctx.get('agents')?.get(id);if(!agent || !task){send(response,400,{ok:false,error:'an existing sessionId and task are required'});return;}
    const job={id:randomUUID(),sessionId:id,status:'queued',createdAt:Date.now()};jobs.set(job.id,job);
    const previous=queues.get(id)||Promise.resolve();
    const execution=previous.catch(()=>{}).then(async()=>{
      await agent.whenIdle();job.status='running';job.startedAt=Date.now();const firstSeq=agent.session.seq;
      agent.followup(createUserMessage({content:[{type:'text',text:task}],source:{kind:'user'}}));
      await agent.whenIdle();Object.assign(job,summary(agent.session,firstSeq),{status:'completed',completedAt:Date.now()});
    }).catch(error=>Object.assign(job,{status:'failed',error:error.message,completedAt:Date.now()}));
    queues.set(id,execution);send(response,202,{ok:true,jobId:job.id,status:'queued'});
  });
  const result=register('/ai-bridge/result',async(request,response)=>{
    if(request.method!=='GET'){send(response,405,{ok:false});return;}
    const id=new URL(request.url,'http://127.0.0.1').searchParams.get('id');const job=jobs.get(id);
    send(response,job?200:404,job?{ok:true,...job}:{ok:false,error:'job not found'});
  });
  ctx.effect(()=>()=>{status();dispatch();result();},'ai-bridge.routes');
}
