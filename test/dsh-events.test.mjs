import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {test} from 'node:test';
import assert from 'node:assert/strict';
const ROOT=path.resolve(import.meta.dirname,'..');
async function runFixture(events,code=0,{close=true,timeoutMs=1000}={}){
  const file=path.join(ROOT,'bin','dsh-bridge-mcp.mjs');
  const source=fs.readFileSync(file,'utf8');
  const body=source.slice(0,source.indexOf('const TOOLS =')).replace(/^#!.*\r?\n/,'').replace(/^import .*;\r?\n/gm,'').replaceAll('import.meta.dirname',JSON.stringify(path.join(ROOT,'bin')));
  let args;
  const spawn=(_exe,argv)=>{
    args=argv;
    const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();
    child.stdout.setEncoding=()=>{};child.stderr.setEncoding=()=>{};child.stdin={end(){}};child.kill=()=>{};
    queueMicrotask(()=>{child.stdout.emit('data',events.map(e=>typeof e==='string'?e:JSON.stringify(e)).join('\n'));if(close)child.emit('close',code);});
    return child;
  };
  const fakeProcess={env:{...process.env,AI_BRIDGE_DEPTH:'0'},platform:process.platform,cwd:()=>ROOT,on(){},exit(){throw new Error('unexpected exit');}};
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  const load=new AsyncFunction('spawn','fs','path','os','localConfig','process','bridgeDepth','DEPTH_ENV',body+'\nreturn runDsh;');
  const run=await load(spawn,fs,path,os,()=>undefined,fakeProcess,()=>0,'AI_BRIDGE_DEPTH');
  const result=await run('task',{timeoutMs});return {result,args};
}
test('structured output returns actual answer and session identity',async()=>{
  const {result,args}=await runFixture([
    {type:'session',sessionId:'session-fixture',cwd:ROOT},
    {type:'thinking',text:'private intermediate reasoning'},
    {type:'tool_call',tool:'bash',callId:'call-1',input:{command:'test'}},
    {type:'status',phase:'turn_end',reason:{kind:'completed'}},
    {type:'final',text:'完成\n中文结果'},
  ]);
  assert.equal(result.answer,'完成\n中文结果');assert.equal(result.sessionId,'session-fixture');
  assert.deepEqual(result.toolCalls,['bash']);assert.ok(args.includes('--json'));
  assert.equal(JSON.stringify(result).includes('private intermediate reasoning'),false);
});
test('failed status is not treated as success even if child exits zero',async()=>{
  const {result}=await runFixture([{type:'session',sessionId:'s'},{type:'status',phase:'turn_end',reason:{kind:'error',error:{message:'tool failed'}}},{type:'final',text:'partial'}]);
  assert.equal(result.ok,false);assert.match(result.error,/tool failed/);
});
test('legacy plain output is still accepted',async()=>{
  const {result}=await runFixture(['legacy answer']);assert.equal(result.ok,true);assert.equal(result.answer,'legacy answer');
});
test('timeout keeps the session identity for recovery',async()=>{
  const {result}=await runFixture([{type:'session',sessionId:'session-recover'}],0,{close:false,timeoutMs:10});assert.equal(result.ok,false);assert.equal(result.sessionId,'session-recover');assert.equal(result.status,'timeout');
});
