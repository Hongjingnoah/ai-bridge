import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {test} from 'node:test';

async function runProbe(filename = './latency-ab.mjs') {
  let now=0;
  const timers=new Set();
  const setTimer=()=>{const timer={};timers.add(timer);return timer;};
  const clearTimer=timer=>timers.delete(timer);
  class FakeServer {
    handlers=new Set();
    async start(){}
    stop(){this.stopped=true;}
    onNotification(fn){this.handlers.add(fn);return ()=>this.handlers.delete(fn);}
    async request(method,params){
      if(method==='thread/start')return {thread:{id:'test'}};
      if(method==='turn/start')queueMicrotask(()=>{
        const emit=(method,params)=>{for(const fn of this.handlers)fn(method,params);};
        now+=1000;
        emit('turn/started',{threadId:'test',turn:{id:'turn'}});
        now+=10; emit('item/completed',{threadId:'test',item:{type:'userMessage'}});
        if(params.effort!=='minimal'){
          now+=90;emit('item/agentMessage/delta',{threadId:'test',delta:'收到'});
          emit('item/completed',{threadId:'test',item:{type:'agentMessage',phase:'final_answer',text:'收到'}});
        }
        emit('thread/tokenUsage/updated',{threadId:'test',tokenUsage:{total:{inputTokens:17}}});
        emit('turn/completed',{threadId:'test',turn:{id:'turn',status:params.effort==='minimal'?'failed':'completed',error:params.effort==='minimal'?{message:'unsupported effort'}:null}});
      });
      return {turn:{id:'turn'}};
    }
  }
  let body=fs.readFileSync(new URL(filename,import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'').replaceAll('import.meta.dirname',JSON.stringify(import.meta.dirname));
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  const run=new AsyncFunction('fs','path','AppServer','Date','console','setTimeout','clearTimeout',body+'\nreturn typeof results !== "undefined" ? results : rows;');
  const records=await run({writeFileSync(){}},path,FakeServer,{now:()=>now},{log(){}},setTimer,clearTimer);
  return {records,timers};
}
test('TTFT ignores completed input items',async()=>{
  const {records}=await runProbe();assert.equal(records[0].ttftMs,100);
});
test('failed turn cannot be ranked as faster success',async()=>{
  const {records}=await runProbe();assert.equal(records[2].ok,false);assert.equal(records[2].status,'failed');assert.equal(records[2].ttftMs,null);
});
test('probe clears timers and reads token usage notifications',async()=>{
  const {records,timers}=await runProbe();assert.equal(timers.size,0);assert.equal(records[0].inputTokens,17);
});
test('v2 repeated benchmark clears all timers',async()=>{
  const {timers}=await runProbe('./latency-ab-v2.mjs');assert.equal(timers.size,0);
});
