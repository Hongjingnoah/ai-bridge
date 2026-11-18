import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CodexJobs} from '../lib/codex-jobs.mjs';
const stateRoot=path.join(os.tmpdir(),'ai-bridge-job-test-state');fs.mkdirSync(stateRoot,{recursive:true});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function queue(runner){return new CodexJobs({runner,stateDir:fs.mkdtempSync(path.join(stateRoot,'run-'))});}
test('submission returns before generation and keeps context for later result',async()=>{
  let finish;const jobs=queue(async opts=>{opts.onThread('thread-real');opts.onDelta('working');return await new Promise(resolve=>finish=resolve);});
  const start=jobs.submit({prompt:'task',cwd:'D:/project'});assert.equal(start.status,'queued');await tick();
  assert.equal(jobs.info(start.jobId).status,'running');assert.equal(jobs.info(start.jobId).threadId,'thread-real');
  finish({threadId:'thread-real',turnId:'turn',text:'done',turn:{status:'completed'}});
  const end=await jobs.result(start.jobId,1000);assert.equal(end.status,'completed');assert.equal(end.result.answer,'done');await jobs.close();
});
test('queue runs one writer at a time',async()=>{
  let active=0,max=0;const jobs=queue(async()=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,10));active--;return {threadId:'t',text:'done',turn:{status:'completed'}};});
  const a=jobs.submit({prompt:'a'}),b=jobs.submit({prompt:'b'});await jobs.result(a.jobId,1000);await jobs.result(b.jobId,1000);assert.equal(max,1);await jobs.close();
});
test('cancellation aborts the worker and keeps thread identity',async()=>{
  const jobs=queue(async opts=>{opts.onThread('resume-me');return await new Promise((_,reject)=>opts.signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));});
  const start=jobs.submit({prompt:'task'});await tick();jobs.cancel(start.jobId);const end=await jobs.result(start.jobId,1000);assert.equal(end.status,'cancelled');assert.equal(end.threadId,'resume-me');await jobs.close();
});
test('completed results survive server recreation and reject path traversal',async()=>{
  const jobs=queue(async()=>({threadId:'saved',text:'persistent',turn:{status:'completed'}}));const start=jobs.submit({prompt:'x'});await jobs.result(start.jobId,1000);await jobs.close();
  const second=new CodexJobs({runner:async()=>{},stateDir:jobs.stateDir});assert.equal(second.info(start.jobId).result.answer,'persistent');assert.throws(()=>second.info('../../other'));await second.close();
});
