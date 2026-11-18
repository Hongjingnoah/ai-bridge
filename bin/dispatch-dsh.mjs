#!/usr/bin/env node
// Direct programmatic DSH dispatch. No desktop input or intermediary is used.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';

const profile=process.env.DSH_PROFILE_DIR || path.join(os.homedir(),'.dsh','profiles','desktop');
const require=createRequire(path.join(profile,'package.json'));
const {Client}=require('@modelcontextprotocol/client');
const {StdioClientTransport}=require('@modelcontextprotocol/client/stdio');
const client=new Client({name:'codex-dsh-dispatch',version:'1.0.0'});
const server=path.join(import.meta.dirname,'dsh-bridge-mcp.mjs');
const argv=process.argv.slice(2);let sessionId,cwd;
for(const option of ['--session-id','--cwd']){const i=argv.indexOf(option);if(i>=0){const value=argv[i+1];if(!value)throw new Error(`${option} needs a value`);if(option==='--session-id')sessionId=value;else cwd=value;argv.splice(i,2);}}
let prompt=argv.join(' ').trim();
if(!prompt)prompt=fs.readFileSync(0,'utf8').trim();
if(!prompt)throw new Error('A task is required through arguments or stdin.');
const started=Date.now();
// MCP stdio inherits only standard OS variables; forward the bridge's scoped
// options explicitly, keeping unrelated parent credentials out of the child.
const bridgeEnv={};
for(const key of ['DSH_PATCH','DSH_CMD','AI_BRIDGE_DEPTH','DSH_BRIDGE_MAX_DEPTH']){
  if(process.env[key]!==undefined)bridgeEnv[key]=process.env[key];
}
try {
  await client.connect(new StdioClientTransport({command:process.execPath,args:[server],cwd:path.resolve(import.meta.dirname,'..'),env:bridgeEnv}));
  const result=await client.callTool({name:'dsh_ask',arguments:{task:prompt,sessionId,cwd,timeoutMs:600000}},{timeout:630000});
  const payload=JSON.parse(result.content?.find(x=>x.type==='text')?.text || '{}');
  console.log(JSON.stringify({...payload,elapsedMs:Date.now()-started},null,2));
  if(result.isError || !payload.ok)process.exitCode=1;
}finally{await client.close();}
