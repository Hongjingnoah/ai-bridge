import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {test} from 'node:test';
import assert from 'node:assert/strict';
test('installed MCP v2 SDK receives timeout in its second argument',async()=>{
  const source=fs.readFileSync(new URL('../bin/dispatch-dsh.mjs',import.meta.url),'utf8');
  const body=source.replace(/^#!.*\r?\n/,'').replace(/^import .*;\r?\n/gm,'').replaceAll('import.meta.dirname',JSON.stringify(path.resolve(import.meta.dirname,'../bin')));
  let called,closed=false,transportOptions;
  class Client{async connect(){}async callTool(params,options){called={params,options};return {content:[{type:'text',text:JSON.stringify({ok:true,answer:'done',sessionId:'session-test'})}]};}async close(){closed=true;}}
  class StdioClientTransport{constructor(options){transportOptions=options;}}
  const require=()=>({Client,StdioClientTransport});
  const fakeProcess={env:{},argv:['node','dispatch','--cwd','D:/task','--session-id','session-test','continue'],execPath:process.execPath};
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  await new AsyncFunction('fs','path','os','createRequire','process','console',body)(fs,path,os,()=>require,fakeProcess,{log(){}});
  assert.equal(called.options?.timeout,630000);
  assert.deepEqual(transportOptions.env,{});
  assert.equal(called.params.arguments.sessionId,'session-test');assert.equal(called.params.arguments.cwd,'D:/task');assert.equal(closed,true);
});

test('DSH dispatch forwards scoped bridge options without forwarding unrelated secrets',async()=>{
  const source=fs.readFileSync(new URL('../bin/dispatch-dsh.mjs',import.meta.url),'utf8');
  const body=source.replace(/^#!.*\r?\n/,'').replace(/^import .*;\r?\n/gm,'').replaceAll('import.meta.dirname',JSON.stringify(path.resolve(import.meta.dirname,'../bin')));
  let transportOptions;
  class Client{async connect(){}async callTool(){return {content:[{type:'text',text:JSON.stringify({ok:true,answer:'done'})}]};}async close(){}}
  class StdioClientTransport{constructor(options){transportOptions=options;}}
  const require=()=>({Client,StdioClientTransport});
  const env={DSH_PATCH:'D:/task with spaces/desktop.patch.yml',DSH_CMD:'D:/existing/dsh.cmd',AI_BRIDGE_DEPTH:'1',DSH_BRIDGE_MAX_DEPTH:'2',UNRELATED_SECRET:'must-not-cross'};
  const fakeProcess={env,argv:['node','dispatch','test'],execPath:process.execPath};
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  await new AsyncFunction('fs','path','os','createRequire','process','console',body)(fs,path,os,()=>require,fakeProcess,{log(){}});
  assert.equal(transportOptions.env?.DSH_PATCH,env.DSH_PATCH);
  assert.equal(transportOptions.env?.DSH_CMD,env.DSH_CMD);
  assert.equal(transportOptions.env?.AI_BRIDGE_DEPTH,'1');
  assert.equal(transportOptions.env?.DSH_BRIDGE_MAX_DEPTH,'2');
  assert.equal(transportOptions.env?.UNRELATED_SECRET,undefined);
  assert.equal(env.UNRELATED_SECRET,'must-not-cross');
});
