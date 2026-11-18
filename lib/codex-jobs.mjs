import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const TERMINAL=new Set(['completed','failed','cancelled']);
export class CodexJobs {
  constructor({runner,stateDir,maxQueue=8}){this.runner=runner;this.stateDir=stateDir;this.maxQueue=maxQueue;this.jobs=new Map();this.queue=[];this.running=null;this.closing=false;fs.mkdirSync(stateDir,{recursive:true});}
  snapshot(job){return {ok:!['failed','cancelled','interrupted'].includes(job.status),jobId:job.id,status:job.status,createdAt:job.createdAt,startedAt:job.startedAt,completedAt:job.completedAt,threadId:job.threadId,cwd:job.options?.cwd||job.cwd,progress:job.progress||'',result:job.result,error:job.error};}
  persist(job){const file=path.join(this.stateDir,job.id+'.json');fs.writeFileSync(file+'.tmp',JSON.stringify(this.snapshot(job),null,2));fs.renameSync(file+'.tmp',file);}
  submit(options){
    if(this.closing)throw new Error('job server is shutting down');
    if(!options.prompt?.trim())throw new Error('prompt is required');
    if(this.queue.length>=this.maxQueue)throw new Error('job queue is full');
    const job={id:randomUUID(),status:'queued',createdAt:Date.now(),options,threadId:options.threadId,controller:new AbortController()};
    job.done=new Promise(resolve=>job.resolve=resolve);this.jobs.set(job.id,job);this.queue.push(job);this.persist(job);queueMicrotask(()=>this.drain());return this.snapshot(job);
  }
  async drain(){
    if(this.running || this.closing)return;
    let job;while((job=this.queue.shift())&&TERMINAL.has(job.status)){}if(!job)return;
    this.running=job;job.status='running';job.startedAt=Date.now();this.persist(job);
    try{
      const result=await this.runner({...job.options,signal:job.controller.signal,
        onThread:threadId=>{job.threadId=threadId;this.persist(job);},
        onDelta:delta=>{job.progress=((job.progress||'')+delta).slice(-2000);if(Date.now()-(job.lastProgressWrite||0)>500){job.lastProgressWrite=Date.now();this.persist(job);}},
      });
      job.threadId=result.threadId;job.result={threadId:result.threadId,turnId:result.turnId,status:result.turn?.status,usage:result.usage??null,answer:result.text};job.status=job.controller.signal.aborted?'cancelled':'completed';
    }catch(error){job.status=job.controller.signal.aborted?'cancelled':'failed';job.error=error.message;if(error.threadId)job.threadId=error.threadId;}
    finally{job.completedAt=Date.now();this.persist(job);job.resolve();this.running=null;queueMicrotask(()=>this.drain());}
  }
  info(id){
    if(!/^[0-9a-f-]{36}$/.test(String(id)))throw new Error('invalid jobId');
    const job=this.jobs.get(id);if(job)return this.snapshot(job);
    const saved=JSON.parse(fs.readFileSync(path.join(this.stateDir,id+'.json'),'utf8'));
    if(['queued','running'].includes(saved.status))return {...saved,ok:false,status:'interrupted',error:'server restarted; resume using the saved threadId'};
    return saved;
  }
  async result(id,waitMs=0){const job=this.jobs.get(id);let timer;
    if(job&&!TERMINAL.has(job.status)&&waitMs>0){try{await Promise.race([job.done,new Promise(resolve=>{timer=setTimeout(resolve,Math.min(waitMs,25000));})]);}finally{clearTimeout(timer);}}
    return this.info(id);
  }
  cancel(id){const job=this.jobs.get(id);if(!job)return this.info(id);if(TERMINAL.has(job.status))return this.snapshot(job);
    job.controller.abort();if(job.status==='queued'){job.status='cancelled';job.completedAt=Date.now();this.persist(job);job.resolve();}return this.snapshot(job);
  }
  async close(){this.closing=true;for(const job of this.jobs.values())if(!TERMINAL.has(job.status))this.cancel(job.id);await Promise.allSettled([...this.jobs.values()].map(job=>job.done));}
}
